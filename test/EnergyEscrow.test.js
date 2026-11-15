const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("EnergyEscrow Prototype Unit Tests", function () {
  async function deployFixture() {
    const [admin, oracle, buyer, generator, attacker] = await ethers.getSigners();
    const EnergyEscrow = await ethers.getContractFactory("EnergyEscrow");
    const escrow = await EnergyEscrow.deploy(admin.address, oracle.address);
    await escrow.waitForDeployment();
    return { escrow, admin, oracle, buyer, generator, attacker };
  }

  it("Test 1: Should allow a buyer to deposit exact collateral and create a Funded trade", async function () {
    const { escrow, buyer, generator } = await deployFixture();
    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    const maxKwh = 2000n;
    const totalDeposit = pricePerKwh * maxKwh;

    await expect(
      escrow.connect(buyer).depositCollateral(generator.address, pricePerKwh, maxKwh, {
        value: totalDeposit,
      })
    )
      .to.emit(escrow, "TradeFunded")
      .withArgs(0, buyer.address, generator.address, maxKwh, totalDeposit);

    const trade = await escrow.trades(0);
    expect(trade.buyer).to.equal(buyer.address);
    expect(trade.depositedAmount).to.equal(totalDeposit);
    expect(trade.status).to.equal(0n);
  });

  it("Test 2: Should reject settlement attempts from unauthorized accounts (Access Control)", async function () {
    const { escrow, buyer, generator, attacker } = await deployFixture();
    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    const maxKwh = 1000n;
    await escrow
      .connect(buyer)
      .depositCollateral(generator.address, pricePerKwh, maxKwh, { value: pricePerKwh * maxKwh });

    const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake-meter-payload"));
    await expect(
      escrow.connect(attacker).executeSettlement(0, 1000n, fakeHash)
    ).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
  });

  it("Test 3: Should execute DvP settlement, deduct 0.75% fee, refund surplus, and mint carbon credits", async function () {
    const { escrow, oracle, buyer, generator } = await deployFixture();
    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    const maxKwh = 2500n;
    const deposited = pricePerKwh * maxKwh;

    await escrow.connect(buyer).depositCollateral(generator.address, pricePerKwh, maxKwh, {
      value: deposited,
    });

    const deliveredKwh = 2000n;
    const gross = deliveredKwh * pricePerKwh;
    const expectedFee = (gross * 75n) / 10000n;
    const expectedPayout = gross - expectedFee;
    const expectedRefund = deposited - gross;
    const meterHash = ethers.keccak256(ethers.toUtf8Bytes("telemetry-batch-001"));

    await expect(
      escrow.connect(oracle).executeSettlement(0, deliveredKwh, meterHash)
    ).to.changeEtherBalances(
      [generator, buyer, escrow],
      [expectedPayout, expectedRefund, -(expectedPayout + expectedRefund)]
    );

    expect(await escrow.carbonCreditsBalance(generator.address)).to.equal(2n);
    expect(await escrow.accumulatedProtocolFees()).to.equal(expectedFee);
  });

  it("Test 4: Should refund full collateral to buyer after 24-hour expiration window", async function () {
    const { escrow, buyer, generator } = await deployFixture();
    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    const maxKwh = 1000n;
    const deposit = pricePerKwh * maxKwh;

    await escrow.connect(buyer).depositCollateral(generator.address, pricePerKwh, maxKwh, {
      value: deposit,
    });

    await expect(escrow.connect(buyer).refundExpired(0)).to.be.revertedWith(
      "Settlement window still active"
    );

    await time.increase(24 * 3600 + 1);

    await expect(escrow.connect(buyer).refundExpired(0)).to.changeEtherBalances(
      [buyer, escrow],
      [deposit, -deposit]
    );
  });

  it("Test 5: Should freeze settlement when a counterparty raises a telemetry dispute", async function () {
    const { escrow, oracle, buyer, generator } = await deployFixture();
    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    const maxKwh = 1000n;

    await escrow.connect(buyer).depositCollateral(generator.address, pricePerKwh, maxKwh, {
      value: pricePerKwh * maxKwh,
    });

    await expect(escrow.connect(generator).raiseDispute(0))
      .to.emit(escrow, "TradeDisputed")
      .withArgs(0, generator.address);

    const meterHash = ethers.keccak256(ethers.toUtf8Bytes("telemetry-batch-002"));
    await expect(
      escrow.connect(oracle).executeSettlement(0, 1000n, meterHash)
    ).to.be.revertedWith("Trade not active");
  });

  describe("Settlement deadline", function () {
    async function fundTrade() {
      const fixture = await deployFixture();
      const { escrow, buyer, generator } = fixture;
      const deposit = ethers.parseEther("1");
      await escrow.connect(buyer).depositCollateral(generator.address, deposit, 1n, {
        value: deposit,
      });
      const trade = await escrow.trades(0);
      const deadline = trade.createdAt + await escrow.SETTLEMENT_WINDOW();
      const meterHash = ethers.id("deadline-telemetry");
      return { ...fixture, deposit, deadline, meterHash };
    }

    it("allows settlement one second before the deadline", async function () {
      const { escrow, oracle, deadline, meterHash } = await fundTrade();
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.connect(oracle).executeSettlement(0, 1n, meterHash))
        .to.emit(escrow, "TradeSettled");
      expect((await escrow.trades(0)).status).to.equal(1n);
    });

    it("allows a dispute one second before the deadline", async function () {
      const { escrow, generator, deadline } = await fundTrade();
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.connect(generator).raiseDispute(0))
        .to.emit(escrow, "TradeDisputed");
      expect((await escrow.trades(0)).status).to.equal(3n);
    });

    it("allows a full refund at the exact deadline", async function () {
      const { escrow, buyer, deposit, deadline } = await fundTrade();
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(buyer).refundExpired(0))
        .to.changeEtherBalances([buyer, escrow], [deposit, -deposit]);
      expect((await escrow.trades(0)).status).to.equal(2n);
    });

    for (const offset of [0n, 1n]) {
      for (const action of ["settlement", "buyer dispute", "generator dispute"]) {
        it(`rejects ${action} at deadline + ${offset}s and preserves the refund`, async function () {
          const { escrow, oracle, buyer, generator, deposit, deadline, meterHash } = await fundTrade();
          await time.setNextBlockTimestamp(deadline + offset);
          const transaction = action === "settlement"
            ? escrow.connect(oracle).executeSettlement(0, 1n, meterHash)
            : escrow.connect(action === "buyer dispute" ? buyer : generator).raiseDispute(0);
          await expect(transaction).to.be.revertedWith("Settlement window expired");
          expect((await escrow.trades(0)).status).to.equal(0n);
          expect(await escrow.accumulatedProtocolFees()).to.equal(0n);
          await expect(escrow.connect(buyer).refundExpired(0))
            .to.changeEtherBalances([buyer, escrow], [deposit, -deposit]);
        });
      }
    }
  });

  it("Test 6: Should allow admin to pause contract in emergency and block new deposits", async function () {
    const { escrow, admin, buyer, generator } = await deployFixture();
    await escrow.connect(admin).pause();

    const pricePerKwh = ethers.parseUnits("0.001", "ether");
    await expect(
      escrow.connect(buyer).depositCollateral(generator.address, pricePerKwh, 500n, {
        value: pricePerKwh * 500n,
      })
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
  });
});
