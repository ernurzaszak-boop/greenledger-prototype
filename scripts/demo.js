const { ethers } = require("hardhat");

async function main() {
  console.log("=================================================================");
  console.log("  GREENLEDGER PROTOTYPE DEMO (EDUCATIONAL SIMULATION - HARDHAT)   ");
  console.log("=================================================================\n");

  const [admin, oracle, buyer, generator] = await ethers.getSigners();
  console.log("[1] Simulated Consortium Accounts:");
  console.log(`    Admin (Multisig Mock): ${admin.address}`);
  console.log(`    IoT Oracle Node:       ${oracle.address}`);
  console.log(`    Industrial Buyer:      ${buyer.address}`);
  console.log(`    Solar Generator:       ${generator.address}\n`);

  console.log("[2] Deploying EnergyEscrow smart contract to local Hardhat network...");
  const EnergyEscrow = await ethers.getContractFactory("EnergyEscrow");
  const escrow = await EnergyEscrow.deploy(admin.address, oracle.address);
  await escrow.waitForDeployment();
  console.log(`    -> Deployed at: ${await escrow.getAddress()}\n`);

  const pricePerKwh = ethers.parseUnits("0.001", "ether");
  const maxKwh = 3000n;
  const depositAmount = pricePerKwh * maxKwh;

  console.log("[3] Buyer locks collateral in escrow for 3,000 kWh...");
  const txFund = await escrow
    .connect(buyer)
    .depositCollateral(generator.address, pricePerKwh, maxKwh, { value: depositAmount });
  await txFund.wait();
  console.log(`    -> Trade #0 Funded! Locked collateral: ${ethers.formatEther(depositAmount)} test units.\n`);

  const deliveredKwh = 2400n;
  const offChainHash = ethers.keccak256(
    ethers.toUtf8Bytes("meter_id=KZ-AST-09|kwh=2400|timestamp=2026-11-13T15:00:00Z")
  );
  console.log("[4] IoT Oracle submits HSM-signed telemetry (2,400 kWh delivered)...");
  console.log(`    -> Off-chain SHA-256 Telemetry Hash: ${offChainHash}`);

  const txSettle = await escrow.connect(oracle).executeSettlement(0, deliveredKwh, offChainHash);
  await txSettle.wait();

  const credits = await escrow.carbonCreditsBalance(generator.address);
  const fees = await escrow.accumulatedProtocolFees();
  console.log("    -> Delivery-vs-Payment Settlement Executed!");
  console.log(`    -> Unused 600 kWh collateral automatically refunded to Buyer.`);
  console.log(`    -> Protocol Clearing Fee (0.75%): ${ethers.formatEther(fees)} test units.`);
  console.log(`    -> Carbon Certificates Minted to Generator: ${credits.toString()} (1 per 1,000 kWh).\n`);

  console.log("=================================================================");
  console.log("  DEMO COMPLETED SUCCESSFULLY - ZERO REAL FUNDS USED             ");
  console.log("=================================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});