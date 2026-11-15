// SPDX-License-Identifier: MIT
// Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract EnergyEscrow is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    uint256 public constant SETTLEMENT_WINDOW = 24 hours;
    uint256 public constant FEE_BPS = 75; // 0.75% platform clearing fee
    uint256 public constant KWH_PER_CARBON_CREDIT = 1000; // 1 certificate per 1,000 kWh

    enum TradeStatus {
        Funded,
        Settled,
        Refunded,
        Disputed
    }

    struct Trade {
        address buyer;
        address generator;
        uint256 pricePerKwh;
        uint256 maxKwh;
        uint256 depositedAmount;
        uint256 deliveredKwh;
        uint256 createdAt;
        TradeStatus status;
    }

    uint256 public nextTradeId;
    uint256 public accumulatedProtocolFees;
    mapping(uint256 => Trade) public trades;
    mapping(address => uint256) public carbonCreditsBalance;

    event TradeFunded(
        uint256 indexed tradeId,
        address indexed buyer,
        address indexed generator,
        uint256 maxKwh,
        uint256 depositedAmount
    );
    event TradeSettled(
        uint256 indexed tradeId,
        uint256 deliveredKwh,
        uint256 generatorPayout,
        uint256 protocolFee,
        uint256 buyerRefund,
        uint256 carbonCreditsMinted
    );
    event TradeRefunded(uint256 indexed tradeId, address indexed buyer, uint256 refundedAmount);
    event TradeDisputed(uint256 indexed tradeId, address indexed raisedBy);

    constructor(address admin, address oracle) {
        require(admin != address(0) && oracle != address(0), "Invalid zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
    }

    function depositCollateral(
        address generator,
        uint256 pricePerKwh,
        uint256 maxKwh
    ) external payable whenNotPaused returns (uint256 tradeId) {
        require(generator != address(0) && generator != msg.sender, "Invalid generator address");
        require(pricePerKwh > 0 && maxKwh > 0, "Invalid price or volume");

        uint256 requiredDeposit = pricePerKwh * maxKwh;
        require(msg.value == requiredDeposit, "Deposit must equal pricePerKwh * maxKwh");

        tradeId = nextTradeId++;
        trades[tradeId] = Trade({
            buyer: msg.sender,
            generator: generator,
            pricePerKwh: pricePerKwh,
            maxKwh: maxKwh,
            depositedAmount: msg.value,
            deliveredKwh: 0,
            createdAt: block.timestamp,
            status: TradeStatus.Funded
        });

        emit TradeFunded(tradeId, msg.sender, generator, maxKwh, msg.value);
    }

    function executeSettlement(
        uint256 tradeId,
        uint256 verifiedKwh,
        bytes32 meterHash
    ) external onlyRole(ORACLE_ROLE) whenNotPaused nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.Funded, "Trade not active");
        require(verifiedKwh > 0 && verifiedKwh <= trade.maxKwh, "Invalid verified kWh");
        require(block.timestamp < trade.createdAt + SETTLEMENT_WINDOW, "Settlement window expired");
        require(meterHash != bytes32(0), "Telemetry hash required");

        trade.deliveredKwh = verifiedKwh;
        trade.status = TradeStatus.Settled;

        uint256 grossAmount = verifiedKwh * trade.pricePerKwh;
        uint256 protocolFee = (grossAmount * FEE_BPS) / 10000;
        uint256 generatorPayout = grossAmount - protocolFee;
        uint256 buyerRefund = trade.depositedAmount - grossAmount;

        accumulatedProtocolFees += protocolFee;

        uint256 creditsMinted = verifiedKwh / KWH_PER_CARBON_CREDIT;
        if (creditsMinted > 0) {
            carbonCreditsBalance[trade.generator] += creditsMinted;
        }

        (bool sentGen, ) = payable(trade.generator).call{value: generatorPayout}("");
        require(sentGen, "Generator payout failed");

        if (buyerRefund > 0) {
            (bool sentBuyer, ) = payable(trade.buyer).call{value: buyerRefund}("");
            require(sentBuyer, "Buyer surplus refund failed");
        }

        emit TradeSettled(
            tradeId,
            verifiedKwh,
            generatorPayout,
            protocolFee,
            buyerRefund,
            creditsMinted
        );
    }

    function refundExpired(uint256 tradeId) external whenNotPaused nonReentrant {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.Funded, "Trade not active");
        require(msg.sender == trade.buyer, "Only buyer can request timeout refund");
        require(block.timestamp >= trade.createdAt + SETTLEMENT_WINDOW, "Settlement window still active");

        uint256 refundAmount = trade.depositedAmount;
        trade.status = TradeStatus.Refunded;

        (bool sent, ) = payable(trade.buyer).call{value: refundAmount}("");
        require(sent, "Refund transfer failed");

        emit TradeRefunded(tradeId, trade.buyer, refundAmount);
    }

    function raiseDispute(uint256 tradeId) external whenNotPaused {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.Funded, "Trade not active");
        require(
            msg.sender == trade.buyer || msg.sender == trade.generator,
            "Only trade counterparties can raise dispute"
        );
        require(block.timestamp < trade.createdAt + SETTLEMENT_WINDOW, "Settlement window expired");
        trade.status = TradeStatus.Disputed;
        emit TradeDisputed(tradeId, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
