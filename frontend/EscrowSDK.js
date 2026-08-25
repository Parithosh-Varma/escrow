import { ethers } from "ethers";

// ABI and address - replace with your deployed contract info
import DecentralizedEscrowABI from "./DecentralizedEscrowABI.json";

class EscrowSDK {
  static STATUS_LABELS = ["Pending", "Funded", "Completed", "Disputed", "Refunded"];

  static isValidAddress(addr) {
    try { return ethers.isAddress(addr); } catch { return false; }
  }

  static formatStatus(statusBigInt) {
    return EscrowSDK.STATUS_LABELS[Number(statusBigInt)] || "Unknown";
  }

  constructor(contractAddress, signerOrProvider) {
    if (!EscrowSDK.isValidAddress(contractAddress)) throw new Error("EscrowSDK: invalid contract address");
    this.contract = new ethers.Contract(
      contractAddress,
      DecentralizedEscrowABI,
      signerOrProvider
    );
  }

  // ---- Escrow Creation ----

  async createEscrow(seller, arbiter, token, amount, expiration, feePercent = 0) {
    if (!EscrowSDK.isValidAddress(seller)) throw new Error("createEscrow: invalid seller");
    if (arbiter && arbiter !== ethers.ZeroAddress && !EscrowSDK.isValidAddress(arbiter)) throw new Error("createEscrow: invalid arbiter");
    if (amount == null || amount <= 0n) throw new Error("createEscrow: invalid amount");
    const tx = await this.contract.createEscrow(
      seller,
      arbiter,
      token || ethers.ZeroAddress,
      amount,
      expiration,
      feePercent
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => this.contract.interface.parseLog(log))
      .find((parsed) => parsed?.name === "EscrowCreated");
    return {
      escrowId: event.args.escrowId.toString(),
      txHash: receipt.hash,
    };
  }

  async batchCreateEscrow(sellers, arbiters, tokens, amounts, expirations, feePercents) {
    const tx = await this.contract.batchCreateEscrow(
      sellers, arbiters, tokens, amounts, expirations, feePercents
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ---- Deposit ----

  async deposit(escrowId, amountETH) {
    const tx = await this.contract.deposit(escrowId, {
      value: amountETH,
    });
    await tx.wait();
    return tx.hash;
  }

  async depositERC20(escrowId, tokenContract, amount) {
    const allowance = await tokenContract.allowance(
      await this.contract.runner.getAddress(),
      this.contract.target
    );
    if (allowance < amount) {
      const approveTx = await tokenContract.approve(this.contract.target, amount);
      await approveTx.wait();
    }
    const tx = await this.contract.deposit(escrowId);
    await tx.wait();
    return tx.hash;
  }

  async batchDeposit(escrowIds, totalETH) {
    const tx = await this.contract.batchDeposit(escrowIds, {
      value: totalETH,
    });
    await tx.wait();
    return tx.hash;
  }

  // ---- Confirmation ----

  async confirmByBuyer(escrowId) {
    const tx = await this.contract.confirmByBuyer(escrowId);
    await tx.wait();
    return tx.hash;
  }

  async confirmBySeller(escrowId) {
    const tx = await this.contract.confirmBySeller(escrowId);
    await tx.wait();
    return tx.hash;
  }

  async release(escrowId) {
    const tx = await this.contract.release(escrowId);
    await tx.wait();
    return tx.hash;
  }

  // ---- Dispute ----

  async openDispute(escrowId) {
    const tx = await this.contract.openDispute(escrowId);
    await tx.wait();
    return tx.hash;
  }

  async resolveDispute(escrowId, releaseToSeller) {
    const resolution = releaseToSeller ? 2 : 4; // Completed (2) or Refunded (4)
    const tx = await this.contract.resolveDispute(escrowId, resolution);
    await tx.wait();
    return tx.hash;
  }

  // ---- Refund ----

  async requestRefund(escrowId) {
    const tx = await this.contract.requestRefund(escrowId);
    await tx.wait();
    return tx.hash;
  }

  // ---- Query ----

  async getEscrow(escrowId) {
    const e = await this.contract.escrows(escrowId);
    return {
      buyer: e.buyer,
      seller: e.seller,
      arbiter: e.arbiter,
      token: e.token,
      amount: e.amount,
      feePercent: e.feePercent,
      createdAt: Number(e.createdAt),
      expiration: Number(e.expiration),
      status: ["Pending", "Funded", "Completed", "Disputed", "Refunded"][Number(e.status)],
      buyerConfirmed: e.buyerConfirmed,
      sellerConfirmed: e.sellerConfirmed,
      disputeCount: Number(e.disputeCount),
    };
  }

  async getEscrowCount() {
    return (await this.contract.escrowCount()).toString();
  }

  async isArbiterApproved(address) {
    const info = await this.contract.arbiters(address);
    return info.isApproved;
  }

  async getArbiterInfo(address) {
    const info = await this.contract.arbiters(address);
    return {
      isApproved: info.isApproved,
      reputation: Number(info.reputation),
      casesResolved: Number(info.casesResolved),
      totalDisputes: Number(info.totalDisputes),
    };
  }

  async isExpired(escrowId) {
    return await this.contract.isExpired(escrowId);
  }

  async getFeePreview(escrowId) {
    const [fee, payout] = await this.contract.getFeePreview(escrowId);
    return { fee, payout };
  }

  async getEscrowDetails(escrowId) {
    const e = await this.contract.getEscrowDetails(escrowId);
    return {
      buyer: e.buyer,
      seller: e.seller,
      arbiter: e.arbiter,
      token: e.token,
      amount: e.amount,
      feePercent: e.feePercent,
      createdAt: Number(e.createdAt),
      expiration: Number(e.expiration),
      status: EscrowSDK.formatStatus(e.status),
      statusRaw: Number(e.status),
      buyerConfirmed: e.buyerConfirmed,
      sellerConfirmed: e.sellerConfirmed,
      disputeCount: Number(e.disputeCount),
      lastDisputeTime: Number(e.lastDisputeTime),
      resolver: e.resolver,
    };
  }

  // ---- Admin ----

  async pause() {
    const tx = await this.contract.pause();
    await tx.wait();
    return tx.hash;
  }

  async unpause() {
    const tx = await this.contract.unpause();
    await tx.wait();
    return tx.hash;
  }

  async addArbiter(address) {
    const tx = await this.contract.addArbiter(address);
    await tx.wait();
    return tx.hash;
  }

  async removeArbiter(address) {
    const tx = await this.contract.removeArbiter(address);
    await tx.wait();
    return tx.hash;
  }

  async updateTreasury(newTreasury) {
    const tx = await this.contract.updateTreasury(newTreasury);
    await tx.wait();
    return tx.hash;
  }

  async updateDefaultFee(newFeePercent) {
    const tx = await this.contract.updateDefaultFee(newFeePercent);
    await tx.wait();
    return tx.hash;
  }

  // ---- Event Listeners ----

  onEscrowCreated(callback) {
    this.contract.on("EscrowCreated", (escrowId, buyer, seller, arbiter, token, amount, expiration, feePercent) => {
      callback({
        escrowId: escrowId.toString(),
        buyer,
        seller,
        arbiter,
        token,
        amount,
        expiration: Number(expiration),
        feePercent: Number(feePercent),
      });
    });
  }

  onEscrowCompleted(callback) {
    this.contract.on("EscrowCompleted", (escrowId, token, amount, fee) => {
      callback({
        escrowId: escrowId.toString(),
        token,
        amount,
        fee,
      });
    });
  }

  onDisputeOpened(callback) {
    this.contract.on("DisputeOpened", (escrowId, opener) => {
      callback({ escrowId: escrowId.toString(), opener });
    });
  }

  onDisputeResolved(callback) {
    this.contract.on("DisputeResolved", (escrowId, status, resolver) => {
      const statusMap = ["Pending", "Funded", "Completed", "Disputed", "Refunded"];
      callback({
        escrowId: escrowId.toString(),
        resolution: statusMap[Number(status)],
        resolver,
      });
    });
  }

  onEscrowRefunded(callback) {
    this.contract.on("EscrowRefunded", (escrowId, amount) => {
      callback({ escrowId: escrowId.toString(), amount });
    });
  }

  onFundsDeposited(callback) {
    this.contract.on("FundsDeposited", (escrowId, depositor, amount) => {
      callback({ escrowId: escrowId.toString(), depositor, amount });
    });
  }

  removeAllListeners() {
    this.contract.removeAllListeners();
  }
}

export default EscrowSDK;
