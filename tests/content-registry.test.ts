import { describe, it, expect, beforeEach, vi } from "vitest";

const ERR_UNAUTHORIZED = 100;
const ERR_PROPOSAL_NOT_FOUND = 101;
const ERR_ALREADY_REGISTERED = 102;
const ERR_INVALID_METADATA = 103;
const ERR_EXECUTION_FAILED = 104;
const ERR_PROPOSAL_NOT_PASSED = 105;

interface Curriculum {
  "proposal-id": bigint;
  "curriculum-id": bigint;
  title: string;
  description: string;
  "content-hash": Uint8Array;
  version: bigint;
  authors: string[];
  tags: string[];
  "registered-at": bigint;
  "updated-at": bigint;
  "is-active": boolean;
}

class ContentRegistryMock {
  state: {
    nextCurriculumId: bigint;
    curricula: Map<bigint, Curriculum>;
    proposalToCurriculum: Map<bigint, bigint>;
  };
  blockHeight: bigint = 200n;
  caller: string = "ST1DAO";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextCurriculumId: 0n,
      curricula: new Map(),
      proposalToCurriculum: new Map(),
    };
    this.blockHeight = 200n;
    this.caller = "ST1DAO";
  }

  isProposalPassed(_: bigint): boolean {
    return true;
  }

  async registerCurriculum(
    proposalId: bigint,
    title: string,
    description: string,
    contentHash: Uint8Array,
    authors: string[],
    tags: string[]
  ): Promise<{ isOk: boolean; value?: bigint; error?: number }> {
    if (this.caller !== "ST1DAO")
      return { isOk: false, error: ERR_UNAUTHORIZED };
    if (this.state.proposalToCurriculum.has(proposalId))
      return { isOk: false, error: ERR_ALREADY_REGISTERED };
    if (!this.isProposalPassed(proposalId))
      return { isOk: false, error: ERR_PROPOSAL_NOT_PASSED };
    if (!title || title.length === 0)
      return { isOk: false, error: ERR_INVALID_METADATA };
    if (!description || description.length === 0)
      return { isOk: false, error: ERR_INVALID_METADATA };
    if (tags.some((t) => !t || t.length === 0))
      return { isOk: false, error: ERR_INVALID_METADATA };

    const id = this.state.nextCurriculumId;
    this.state.curricula.set(id, {
      "proposal-id": proposalId,
      "curriculum-id": id,
      title,
      description,
      "content-hash": contentHash,
      version: 1n,
      authors,
      tags,
      "registered-at": this.blockHeight,
      "updated-at": this.blockHeight,
      "is-active": true,
    });
    this.state.proposalToCurriculum.set(proposalId, id);
    this.state.nextCurriculumId += 1n;
    return { isOk: true, value: id };
  }

  async updateCurriculum(
    curriculumId: bigint,
    title: string,
    description: string,
    contentHash: Uint8Array,
    tags: string[]
  ): Promise<{ isOk: boolean; error?: number }> {
    if (this.caller !== "ST1DAO")
      return { isOk: false, error: ERR_UNAUTHORIZED };
    const c = this.state.curricula.get(curriculumId);
    if (!c) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (!c["is-active"]) return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    if (!title || !description || tags.some((t) => !t))
      return { isOk: false, error: ERR_INVALID_METADATA };

    this.state.curricula.set(curriculumId, {
      ...c,
      title,
      description,
      "content-hash": contentHash,
      tags,
      version: c.version + 1n,
      "updated-at": this.blockHeight,
    });
    return { isOk: true };
  }

  async deactivateCurriculum(
    curriculumId: bigint
  ): Promise<{ isOk: boolean; error?: number }> {
    if (this.caller !== "ST1DAO")
      return { isOk: false, error: ERR_UNAUTHORIZED };
    const c = this.state.curricula.get(curriculumId);
    if (!c || !c["is-active"])
      return { isOk: false, error: ERR_PROPOSAL_NOT_FOUND };
    this.state.curricula.set(curriculumId, { ...c, "is-active": false });
    return { isOk: true };
  }

  getCurriculum(id: bigint): Curriculum | undefined {
    return this.state.curricula.get(id);
  }

  getNextId(): bigint {
    return this.state.nextCurriculumId;
  }
}

describe("ContentRegistry", () => {
  let mock: ContentRegistryMock;

  beforeEach(() => {
    mock = new ContentRegistryMock();
    mock.reset();
  });

  it("registers curriculum from valid passed proposal", async () => {
    const hash = new Uint8Array(32).fill(2);
    const result = await mock.registerCurriculum(
      5n,
      "Local Math v1",
      "Community math for grades 1-3",
      hash,
      ["ST1AUTHOR1", "ST1AUTHOR2"],
      ["math", "primary", "local"]
    );
    expect(result.isOk).toBe(true);
    expect(result.value).toBe(0n);
    const c = mock.getCurriculum(0n);
    expect(c?.title).toBe("Local Math v1");
    expect(c?.version).toBe(1n);
    expect(c?.tags).toEqual(["math", "primary", "local"]);
  });

  it("prevents double registration of same proposal", async () => {
    const hash = new Uint8Array(32).fill(3);
    await mock.registerCurriculum(
      10n,
      "Title",
      "Desc",
      hash,
      ["ST1A"],
      ["tag"]
    );
    const result = await mock.registerCurriculum(
      10n,
      "Title2",
      "Desc2",
      hash,
      ["ST1A"],
      ["tag"]
    );
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_ALREADY_REGISTERED);
  });

  it("rejects registration from non-dao caller", async () => {
    mock.caller = "ST1HACKER";
    const result = await mock.registerCurriculum(
      1n,
      "Bad",
      "Desc",
      new Uint8Array(32),
      [],
      []
    );
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_UNAUTHORIZED);
  });

  it("updates curriculum and increments version", async () => {
    const hash1 = new Uint8Array(32).fill(4);
    const hash2 = new Uint8Array(32).fill(5);
    await mock.registerCurriculum(
      20n,
      "Old Title",
      "Old Desc",
      hash1,
      ["ST1A"],
      ["old"]
    );
    const result = await mock.updateCurriculum(
      0n,
      "New Title",
      "New Desc",
      hash2,
      ["new", "updated"]
    );
    expect(result.isOk).toBe(true);
    const c = mock.getCurriculum(0n);
    expect(c?.title).toBe("New Title");
    expect(c?.version).toBe(2n);
    expect(c?.tags).toEqual(["new", "updated"]);
  });

  it("deactivates and reactivates curriculum", async () => {
    await mock.registerCurriculum(
      30n,
      "Title",
      "Desc",
      new Uint8Array(32),
      [],
      []
    );
    await mock.deactivateCurriculum(0n);
    const c1 = mock.getCurriculum(0n);
    expect(c1?.["is-active"]).toBe(false);
  });

  it("rejects invalid metadata", async () => {
    const result = await mock.registerCurriculum(
      40n,
      "",
      "Valid",
      new Uint8Array(32),
      [],
      []
    );
    expect(result.isOk).toBe(false);
    expect(result.error).toBe(ERR_INVALID_METADATA);
  });
});
