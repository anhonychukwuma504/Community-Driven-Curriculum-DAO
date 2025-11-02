// tests/treasury-pool.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const ERR_UNAUTHORIZED = 100;
const ERR_PROPOSAL_NOT_FOUND = 101;
const ERR_INSUFFICIENT_FUNDS = 102;
const ERR_ALREADY_RELEASED = 103;
const ERR_INVALID_AMOUNT = 104;
const ERR_PROPOSAL_NOT_PASSED = 105;
const ERR_EXECUTION_FAILED = 106;

interface ProposalFunding {
  amount: bigint;
  recipient: string;
  released: boolean;
  "proposal-id": bigint;
}

class TreasuryPoolMock {
  state: {
    totalReserved: bigint;
    totalReleased: bigint;
    proposalFunding: Map<bigint, ProposalFunding>;
    donations: Map<string, bigint>;
    stxBalance: bigint;
    admin: string;
    authority: string;
  };
  caller: string = "ST1DONOR";
  stxTransfers: Array<{ amount: bigint; from: string; to: string }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      totalReserved: 0n,
      totalReleased: 0n,
      proposalFunding: new Map(),
      donations: new Map(),
      stxBalance: 10000000n,
      admin: "ST1ADMIN",
      authority: "ST1AUTH",
    };
    this.caller = "ST1DONOR";
    this.stxTransfers = [];
  }

  async donate(amount: bigint): Promise<{ isOk: boolean; error?: number }> {
    if (amount <= 0n) return { isOk: false, error: ERR_INVALID_AMOUNT };
    if (amount > this.state.stxBalance)
      return { isOk: false, error: ERR_INSUFFICIENT_FUNDS };
    this.state.stxBalance += amount;
    const current = this.state.donations.get(this.caller) || 0n;
    this.state.donations.set(this.caller, current + amount);
    this.stxTransfers.push({ amount, from: this.caller, to: "contract" });
    return { isOk: true };
  }

  async reserveFunds(
    proposalId: bigint,
    amount: bigint,
    recipient: string
  ): Promise<{ isOk: boolean; error?: number }> {
    if (this.caller !== this.state.authority)
      return { isOk: false, error: ERR_UNAUTHORIZED };
    if (amount <= 0n) return { isOk: false, error: ERR_INVALID_AMOUNT };
    if (this.state.proposalFunding.has(proposalId))
      return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (this.state.stxBalance < this.state.totalReserved + amount)
      return { isOk: false, error: ERR_INSUFFICIENT_FUNDS };

    this.state.proposalFunding.set(proposalId, {
      amount,
      recipient,
      released: false,
      "proposal-id": proposalId,
    });
    this.state.totalReserved += amount;
    return { isOk: true };
  }

  async releaseFunds(
    proposalId: bigint
  ): Promise<{ isOk: boolean; error?: number }> {
    if (this.caller !== "ST1DAO")
      return { isOk: false, error: ERR_UNAUTHORIZED };
    const funding = this.state.proposalFunding.get(proposalId);
    if (!funding) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (funding.released) return { isOk: false, error: ERR_ALREADY_RELEASED };
    if (!this.isProposalPassed(proposalId))
      return { isOk: false, error: ERR_PROPOSAL_NOT_PASSED };

    this.stxTransfers.push({
      amount: funding.amount,
      from: "contract",
      to: funding.recipient,
    });
    this.state.proposalFunding.set(proposalId, { ...funding, released: true });
    this.state.totalReserved -= funding.amount;
    this.state.totalReleased += funding.amount;
    return { isOk: true };
  }

  isProposalPassed(_: bigint): boolean {
    return true;
  }

  getProposalFunding(id: bigint): ProposalFunding | undefined {
    return this.state.proposalFunding.get(id);
  }

  getTotalReserved(): bigint {
    return this.state.totalReserved;
  }

  getTotalReleased(): bigint {
    return this.state.totalReleased;
  }

  getTreasuryBalance(): bigint {
    return this.state.stxBalance;
  }
}

describe("TreasuryPool", () => {
  let mock: TreasuryPoolMock;

  beforeEach(() => {
    mock = new TreasuryPoolMock();
    mock.reset();
  });

  it("accepts donation and tracks donor balance", async () => {
    const result = await mock.donate(500000n);
    expect(result.isOk).toBe(true);
    expect(mock.state.donations.get("ST1DONOR")).toBe(500000n);
    expect(mock.stxTransfers).toContainEqual({
      amount: 500000n,
      from: "ST1DONOR",
      to: "contract",
    });
  });

  it("reserves funds for proposal when authorized", async () => {
    mock.caller = "ST1AUTH";
    await mock.donate(1000000n);
    const result = await mock.reserveFunds(1n, 300000n, "ST1RECIPIENT");
    expect(result.isOk).toBe(true);
    const funding = mock.getProposalFunding(1n);
    expect(funding?.amount).toBe(300000n);
    expect(mock.getTotalReserved()).toBe(300000n);
  });

  it("rejects reserve if insufficient treasury balance", async () => {
    mock.caller = "ST1AUTH";
    const result = await mock.reserveFunds(1n, 99999999n, "ST1RECIPIENT");
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_INSUFFICIENT_FUNDS);
  });

  it("releases funds only from dao-governance and if passed", async () => {
    mock.caller = "ST1AUTH";
    await mock.donate(500000n);
    await mock.reserveFunds(1n, 200000n, "ST1RECIPIENT");
    mock.caller = "ST1DAO";
    const result = await mock.releaseFunds(1n);
    expect(result.isOk).toBe(true);
    const funding = mock.getProposalFunding(1n);
    expect(funding?.released).toBe(true);
    expect(mock.getTotalReleased()).toBe(200000n);
    expect(mock.stxTransfers).toContainEqual({
      amount: 200000n,
      from: "contract",
      to: "ST1RECIPIENT",
    });
  });

  it("prevents double release", async () => {
    mock.caller = "ST1AUTH";
    await mock.donate(500000n);
    await mock.reserveFunds(1n, 200000n, "ST1RECIPIENT");
    mock.caller = "ST1DAO";
    await mock.releaseFunds(1n);
    const result = await mock.releaseFunds(1n);
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_ALREADY_RELEASED);
  });

  it("rejects release if proposal not passed", async () => {
    mock.caller = "ST1AUTH";
    await mock.donate(500000n);
    await mock.reserveFunds(1n, 200000n, "ST1RECIPIENT");
    mock.caller = "ST1DAO";
    vi.spyOn(mock, "isProposalPassed").mockReturnValue(false);
    const result = await mock.releaseFunds(1n);
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_PROPOSAL_NOT_PASSED);
  });
});
