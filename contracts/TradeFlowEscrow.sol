// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TradeFlowEscrow
 * @notice Simple trade-finance escrow for the XRPL EVM Sidechain.
 *
 * Flow
 * ----
 * 1. Importer deposits funds and creates an escrow.
 * 2. Exporter (or any authorised caller) calls release() once conditions
 *    are met (time-lock has passed or arbiter approves).
 * 3. If the trade is disputed or the time-lock expires with no release,
 *    the importer can call refund().
 *
 * Deploy target: XRPL EVM Sidechain Devnet
 *   RPC : https://rpc.evm.devnet.ripple.com
 *   Chain ID : 1440002
 *
 * @dev For a production deployment replace the simple time-lock with a
 *      proper multi-sig or oracle-based condition check.
 */
contract TradeFlowEscrow {

    // ── Types ──────────────────────────────────────────────────────────────

    enum Status { Pending, Released, Refunded }

    struct Escrow {
        address payable importer;   // depositor / buyer
        address payable exporter;   // recipient / seller
        uint256 amount;             // locked value in wei
        uint256 releaseAfter;       // unix timestamp — earliest release
        uint256 refundAfter;        // unix timestamp — importer can reclaim
        string  tradeId;            // off-chain reference (matches XRPL memo)
        Status  status;
    }

    // ── State ──────────────────────────────────────────────────────────────

    uint256 public escrowCount;
    mapping(uint256 => Escrow) public escrows;

    // ── Events ─────────────────────────────────────────────────────────────

    event EscrowCreated(
        uint256 indexed id,
        address indexed importer,
        address indexed exporter,
        uint256 amount,
        string  tradeId
    );
    event EscrowReleased(uint256 indexed id);
    event EscrowRefunded(uint256 indexed id);

    // ── Errors ─────────────────────────────────────────────────────────────

    error NotImporter();
    error NotExporter();
    error TooEarly();
    error AlreadySettled();
    error ZeroAmount();
    error TransferFailed();

    // ── Mutating functions ─────────────────────────────────────────────────

    /**
     * @notice Create an escrow.  Send the settlement amount as msg.value.
     * @param exporter_      Recipient address (exporter / seller)
     * @param releaseDelay   Seconds from now before exporter can release
     * @param refundDelay    Seconds from now before importer can reclaim
     * @param tradeId_       Off-chain trade identifier (must match XRPL memo)
     */
    function createEscrow(
        address payable exporter_,
        uint256 releaseDelay,
        uint256 refundDelay,
        string calldata tradeId_
    ) external payable returns (uint256 id) {
        if (msg.value == 0) revert ZeroAmount();

        id = escrowCount++;
        escrows[id] = Escrow({
            importer:     payable(msg.sender),
            exporter:     exporter_,
            amount:       msg.value,
            releaseAfter: block.timestamp + releaseDelay,
            refundAfter:  block.timestamp + refundDelay,
            tradeId:      tradeId_,
            status:       Status.Pending
        });

        emit EscrowCreated(id, msg.sender, exporter_, msg.value, tradeId_);
    }

    /**
     * @notice Release funds to the exporter.  Callable by exporter after
     *         the release time-lock has passed.
     */
    function release(uint256 id) external {
        Escrow storage e = escrows[id];
        if (msg.sender != e.exporter) revert NotExporter();
        if (e.status != Status.Pending)  revert AlreadySettled();
        if (block.timestamp < e.releaseAfter) revert TooEarly();

        e.status = Status.Released;
        emit EscrowReleased(id);

        (bool ok, ) = e.exporter.call{value: e.amount}("");
        if (!ok) revert TransferFailed();
    }

    /**
     * @notice Refund locked funds to the importer.  Callable by importer
     *         after the refund time-lock has passed.
     */
    function refund(uint256 id) external {
        Escrow storage e = escrows[id];
        if (msg.sender != e.importer) revert NotImporter();
        if (e.status != Status.Pending)  revert AlreadySettled();
        if (block.timestamp < e.refundAfter) revert TooEarly();

        e.status = Status.Refunded;
        emit EscrowRefunded(id);

        (bool ok, ) = e.importer.call{value: e.amount}("");
        if (!ok) revert TransferFailed();
    }

    // ── View functions ─────────────────────────────────────────────────────

    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return escrows[id];
    }
}
