import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, encodePacked, keccak256, parseUnits, zeroHash } from "viem";

const DAY = 86_400n;

describe("GiwaMandateExecutor", async () => {
  const { viem } = await network.connect();

  async function fixture() {
    const [owner, agent, recipient, outsider] = await viem.getWalletClients();
    const token = await viem.deployContract("MockERC20");
    const executor = await viem.deployContract("GiwaMandateExecutor");
    const publicClient = await viem.getPublicClient();
    const latest = await publicClient.getBlock();
    const now = latest.timestamp;
    const total = parseUnits("100", 18);
    await token.write.mint([owner.account.address, total]);
    await token.write.approve([executor.address, total], { account: owner.account });
    const purposeHash = keccak256(encodePacked(["string"], ["approved-services"]));
    const chainId = await publicClient.getChainId();
    const mandateId = keccak256(encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [owner.account.address, agent.account.address, token.address, recipient.account.address, 0n, BigInt(chainId)],
    ));
    await executor.write.createMandate([
      agent.account.address,
      token.address,
      recipient.account.address,
      parseUnits("20", 18),
      total,
      now,
      now + 30n * DAY,
      DAY,
      purposeHash,
    ], { account: owner.account });
    return { owner, agent, recipient, outsider, token, executor, publicClient, mandateId, now };
  }

  it("executes an allowed payment and records a unique reference", async () => {
    const { agent, recipient, token, executor, mandateId } = await fixture();
    const reference = keccak256(encodePacked(["string"], ["payment-1"]));
    const amount = parseUnits("5", 18);
    const preview = await executor.read.previewPayment([mandateId, amount, reference]);
    assert.equal(preview[0], 0);
    await executor.write.executePayment([mandateId, amount, reference], { account: agent.account });
    assert.equal(await token.read.balanceOf([recipient.account.address]), amount);
    assert.equal(await executor.read.consumedPaymentReferences([reference]), true);
  });

  it("escalates an over-limit payment and accepts one owner-approved exception", async () => {
    const { owner, agent, executor, mandateId, now } = await fixture();
    const reference = keccak256(encodePacked(["string"], ["exception-payment"]));
    const amount = parseUnits("25", 18);
    assert.equal((await executor.read.previewPayment([mandateId, amount, reference]))[0], 1);
    await executor.write.approveException([mandateId, reference, amount, now + DAY], { account: owner.account });
    assert.equal((await executor.read.previewPayment([mandateId, amount, reference]))[0], 0);
    await executor.write.executePayment([mandateId, amount, reference], { account: agent.account });
    await assert.rejects(
      executor.write.executePayment([mandateId, amount, reference], { account: agent.account }),
    );
  });

  it("blocks paused and revoked mandates", async () => {
    const { owner, agent, executor, mandateId } = await fixture();
    const reference = keccak256(encodePacked(["string"], ["paused-payment"]));
    await executor.write.setPaused([mandateId, true], { account: owner.account });
    assert.equal((await executor.read.previewPayment([mandateId, parseUnits("5", 18), reference]))[0], 2);
    await assert.rejects(
      executor.write.executePayment([mandateId, parseUnits("5", 18), reference], { account: agent.account }),
    );
    await executor.write.setPaused([mandateId, false], { account: owner.account });
    await executor.write.revokeMandate([mandateId], { account: owner.account });
    assert.equal((await executor.read.previewPayment([mandateId, parseUnits("5", 18), zeroHash]))[0], 2);
  });

  it("rejects callers other than the declared agent", async () => {
    const { outsider, executor, mandateId } = await fixture();
    const reference = keccak256(encodePacked(["string"], ["outsider-payment"]));
    await assert.rejects(
      executor.write.executePayment([mandateId, parseUnits("5", 18), reference], { account: outsider.account }),
    );
  });
});
