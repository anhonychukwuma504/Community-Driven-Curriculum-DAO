import { describe, it, expect, beforeEach, vi } from "vitest";
import { Cl, ClarityType, cvToValue } from "@stacks/transactions";
import { uintCV, boolCV, stringUtf8CV, buffCV, someCV, noneCV } from "@stacks/transactions";

const ERR_UNAUTHORIZED = 100;
const ERR_PROPOSAL_NOT_FOUND = 101;
const ERR_INVALID_STATE = 102;
const ERR_VOTING_CLOSED = 103;
const ERR_ALREADY_VOTED = 104;
const ERR_INSUFFICIENT_STAKE = 105;
const ERR_EXECUTION_FAILED = 106;
const ERR_INVALID_THRESHOLD = 107;
const ERR_PROPOSAL_EXISTS = 108;

interface Proposal {
  id: bigint;
  title: string;
  description: string;
  proposer: string;
  stake: bigint;
  "start-block": bigint;
  "end-block": bigint;
  state: bigint;
  "yes-votes": bigint;
  "no-votes": bigint;
  executed: boolean;
}

interface Vote {
  support: boolean;
  weight: bigint;
}

class DAOGovernanceMock {
  state: {
    nextProposalId: bigint;
    minStakeToPropose: bigint;
    votingDuration: bigint;
    executionDelay: bigint;
    passingThreshold: bigint;
    proposals: Map<bigint, Proposal>;
    votes: Map<string, Vote>;
    proposalHashes: Map<bigint, Uint8Array>;
    authorityContract: string;
    stxTransfers: Array<{ amount: bigint; from: string; to: string }>;
  };
  blockHeight: bigint = 100n;
  caller: string = "ST1PROPOSER";
  contracts: { treasury: any; registry: any; rewards: any };

  constructor() {
    this.reset();
    this.contracts = {
      treasury: { "release-funds": vi.fn().mockResolvedValue({ isOk: true }) },
      registry: { "register-curriculum": vi.fn().mockResolvedValue({ isOk: true }) },
      rewards: { distribute: vi.fn().mockResolvedValue({ isOk: true }) },
    };
  }

  reset() {
    this.state = {
      nextProposalId: 0n,
      minStakeToPropose: 1000000n,
      votingDuration: 144n,
      executionDelay: 10n,
      passingThreshold: 51n,
      proposals: new Map(),
      votes: new Map(),
      proposalHashes: new Map(),
      authorityContract: "ST1AUTH",
      stxTransfers: [],
    };
    this.blockHeight = 100n;
    this.caller = "ST1PROPOSER";
  }

  async submitProposal(
    title: string,
    description: string,
    contentHash: Uint8Array,
    stakeAmount: bigint
  ): Promise<{ isOk: boolean; value?: bigint; error?: number }> {
    if (stakeAmount < this.state.minStakeToPropose) return { isOk: false, error: ERR_INSUFFICIENT_STAKE };
    const id = this.state.nextProposalId;
    if (this.state.proposalHashes.has(id)) return { isOk: false, error: ERR_PROPOSAL_EXISTS };

    this.state.stxTransfers.push({ amount: stakeAmount, from: this.caller, to: this.caller });
    const start = this.blockHeight + 1n;
    const end = start + this.state.votingDuration;

    this.state.proposals.set(id, {
      id,
      title,
      description,
      proposer: this.caller,
      stake: stakeAmount,
      "start-block": start,
      "end-block": end,
      state: 0n,
      "yes-votes": 0n,
      "no-votes": 0n,
      executed: false,
    });
    this.state.proposalHashes.set(id, contentHash);
    this.state.nextProposalId += 1n;
    return { isOk: true, value: id };
  }

  async startVoting(proposalId: bigint): Promise<{ isOk: boolean; value?: boolean; error?: number }> {
    const p = this.state.proposals.get(proposalId);
    if (!p) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (p.proposer !== this.caller) return { isOk: false, error: ERR_UNAUTHORIZED };
    if (p.state !== 0n) return { isOk: false, error: ERR_INVALID_STATE };
    if (this.blockHeight < p["start-block"]) return { isOk: false, error: ERR_INVALID_STATE };

    this.state.proposals.set(proposalId, { ...p, state: 1n, "start-block": this.blockHeight });
    return { isOk: true, value: true };
  }

  async castVote(proposalId: bigint, support: boolean, weight: bigint): Promise<{ isOk: boolean; error?: number }> {
    const p = this.state.proposals.get(proposalId);
    if (!p) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (p.state !== 1n || this.blockHeight < p["start-block"] || this.blockHeight > p["end-block"])
      return { isOk: false, error: ERR_VOTING_CLOSED };

    const key = `${proposalId}-${this.caller}`;
    if (this.state.votes.has(key)) return { isOk: false, error: ERR_ALREADY_VOTED };
    if (weight <= 0n) return { isOk: false, error: ERR_INSUFFICIENT_STAKE };

    this.state.votes.set(key, { support, weight });
    const yes = support ? p["yes-votes"] + weight : p["yes-votes"];
    const no = support ? p["no-votes"] : p["no-votes"] + weight;
    this.state.proposals.set(proposalId, { ...p, "yes-votes": yes, "no-votes": no });
    return { isOk: true };
  }

  async endVoting(proposalId: bigint): Promise<{ isOk: boolean; value?: boolean; error?: number }> {
    const p = this.state.proposals.get(proposalId);
    if (!p) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (this.blockHeight < p["end-block"]) return { isOk: false, error: ERR_VOTING_CLOSED };
    if (p.state !== 1n) return { isOk: false, error: ERR_INVALID_STATE };

    const total = p["yes-votes"] + p["no-votes"];
    const yesPercent = total > 0n ? (p["yes-votes"] * 100n) / total : 0n;
    const passed = yesPercent >= this.state.passingThreshold;
    this.state.proposals.set(proposalId, { ...p, state: passed ? 2n : 3n });
    return { isOk: true, value: passed };
  }

  async executeProposal(proposalId: bigint): Promise<{ isOk: boolean; error?: number }> {
    const p = this.state.proposals.get(proposalId);
    if (!p) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (p.state !== 2n) return { isOk: false, error: ERR_INVALID_STATE };
    if (p.executed) return { isOk: false, error: ERR_EXECUTION_FAILED };
    if (this.blockHeight < p["end-block"] + this.state.executionDelay) return { isOk: false, error: ERR_INVALID_STATE };

    this.state.proposals.set(proposalId, { ...p, state: 4n });
    this.state.proposals.set(proposalId, { ...p, state: 5n, executed: true });
    return { isOk: true };
  }

  getProposal(id: bigint): Proposal | undefined {
    return this.state.proposals.get(id);
  }

  getNextId(): bigint {
    return this.state.nextProposalId;
  }
}

describe("DAOGovernance", () => {
  let mock: DAOGovernanceMock;

  beforeEach(() => {
    mock = new DAOGovernanceMock();
    mock.reset();
  });

  it("submits proposal with valid stake", async () => {
    const result = await mock.submitProposal(
      "Math for All",
      "Community-driven math curriculum",
      new Uint8Array(32).fill(1),
      1000000n
    );
    expect(result.isOk).toBe(true);
    expect(result.value).toBe(0n);
    const p = mock.getProposal(0n);
    expect(p?.title).toBe("Math for All");
    expect(p?.stake).toBe(1000000n);
  });

  it("rejects proposal with insufficient stake", async () => {
    const result = await mock.submitProposal("Low Stake", "Desc", new Uint8Array(32), 999999n);
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_INSUFFICIENT_STAKE);
  });

  it("starts voting only by proposer after start block", async () => {
    await mock.submitProposal("Test", "Desc", new Uint8Array(32), 1000000n);
    mock.blockHeight = 101n;
    const result = await mock.startVoting(0n);
    expect(result.isOk).toBe(true);
    const p = mock.getProposal(0n);
    expect(p?.state).toBe(1n);
  });

  it("rejects vote after voting period", async () => {
    await mock.submitProposal("Test", "Desc", new Uint8Array(32), 1000000n);
    mock.blockHeight = 101n;
    await mock.startVoting(0n);
    mock.blockHeight = 300n;
    const result = await mock.castVote(0n, true, 100n);
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_VOTING_CLOSED);
  });

  it("calculates passing threshold correctly", async () => {
    await mock.submitProposal("Test", "Desc", new Uint8Array(32), 1000000n);
    mock.blockHeight = 101n;
    await mock.startVoting(0n);
    await mock.castVote(0n, true, 60n);
    await mock.castVote(0n, false, 40n);
    mock.blockHeight = 250n;
    const result = await mock.endVoting(0n);
    expect(result.isOk).toBe(true);
    expect(result.value).toBe(true);
    const p = mock.getProposal(0n);
    expect(p?.state).toBe(2n);
  });

  it("executes passed proposal after delay", async () => {
    await mock.submitProposal("Test", "Desc", new Uint8Array(32), 1000000n);
    mock.blockHeight = 101n;
    await mock.startVoting(0n);
    await mock.castVote(0n, true, 100n);
    mock.blockHeight = 250n;
    await mock.endVoting(0n);
    mock.blockHeight = 261n;
    const result = await mock.executeProposal(0n);
    expect(result.isOk).toBe(true);
    const p = mock.getProposal(0n);
    expect(p?.executed).toBe(true);
    expect(p?.state).toBe(5n);
  });
});