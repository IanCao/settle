# Project submission - Settle

Portal → Contribute → **Projects** → 项目提交. Values below are final; the
character counts are the ones the form enforces.

| Field | Limit | Value |
|---|---|---|
| 项目名称 | - | Settle |
| 一句话简介 | 180 | 178 chars |
| 描述 | 1000 | 984 chars |
| 使用步骤 | - | 5 steps |
| 预期验证结果 | 500 | 495 chars |
| 网站 | required | https://iancao.github.io/settle/ |
| GitHub | required | https://github.com/IanCao/settle |
| 证明材料 | required, GitHub Repository | https://github.com/IanCao/settle |

## 01 基本信息

**项目名称**

```
Settle
```

**标志** - upload `app/logo.png` (512×512, PNG). One bar split 70/30: the payout
table, in one shape.

**主标签 / 标签 1 / 标签 2** - 主标签 `交易市场` (Marketplaces); the sub-tag list
that appears under it decides the rest. If `DeFi` is offered as a primary and
`Escrow` as a topic, that pair is even closer to what this is.

## 02 一句话简介

```
Escrow that pays in basis points, not yes/no: write acceptance criteria in plain words, let validators judge the artifact, and split the money by how much of it was actually met.
```

## 03 描述

```
Settle is an escrow whose release condition is written in words, not signed off. The client funds it and pins the acceptance criteria in the contract up front; the provider later submits one URL. Validators fetch that artifact and judge it against criteria written days earlier.

The payout is in basis points - ACCEPT 100%, PARTIAL 50%, REJECT 0% - split by the contract. Partial acceptance is the normal case in real work, and what a boolean escrow cannot express.

Round one is asymmetric: only the provider has a document on record, so every validator re-fetches it and derives its own decision; the leader is accepted only on verdict equality. The client may escalate inside the window with counter evidence, making round two adversarial: both documents, no deference to the first answer.

An unreachable artifact is a REJECT, not an error, so a dead link cannot wedge the escrow; text inside a deliverable is data, never instruction. For milestones, grant tranches and bounties.
```

## 04 演示视频

Optional. A 60-second recording of fund → deliver → judge → escalate is the
single highest-value extra; skip it rather than rushing one.

## 05 使用步骤

**Step 1 - 标题: Open the app**

```
Open https://iancao.github.io/settle/. The escrow list renders with no wallet connected, because every read is a simulation against Studionet.
```

**Step 2 - 标题: Connect a wallet**

```
Click "Connect wallet". The app switches the wallet to GenLayer Studionet (chain id 61999) or adds the chain if it is missing, then shows the shortened address.
```

**Step 3 - 标题: Fund an escrow**

```
Fill in a provider address, acceptance criteria in plain words ("a README section of at least 300 words with one working command block"), 0.05 GEN and a 3-day deadline, then confirm. Watch the bottom-right panel move through proposing / committing / revealing to accepted.
```

**Step 4 - 标题: Deliver and judge**

```
Switch the wallet to the provider account and press "Submit deliverable" with any public URL. Switch back, or use a third account: "Judge (round 1)" is callable by anyone. Validators fetch the URL and return ACCEPT, PARTIAL or REJECT with a payout percentage.
```

**Step 5 - 标题: Escalate or settle**

```
As the client, press "Escalate with counter evidence" inside the one-hour window and paste a URL that argues against the verdict; anyone can then press "Resolve dispute (round 2)". If the window lapses instead, "Settle" makes round one final. The split is credited and "Withdraw" sends it out.
```

## 06 预期验证结果

```
Step 3: a card #0 appears as FUNDED, amount 0.05 GEN, the criteria, both addresses and a deadline countdown.

Step 4: the card reads DELIVERED with the artifact link openable, then JUDGED with ACCEPT / PARTIAL / REJECT, a payout percentage and one line of reasoning.

Step 5: DISPUTED shows both evidence links; after round two the card reads SETTLED with the provider share (say 50%) and a Withdraw button for it. Past the deadline with nothing delivered, it turns REFUNDED for the full amount.
```

**合约链接**

```
https://explorer-studio.genlayer.com/address/0x28Ee25d23d30f8E7C53eF54DBf0dF328813E3105
```

## 07 项目链接

| Field | Value |
|---|---|
| 网站 | https://iancao.github.io/settle/ |
| GitHub | `https://github.com/IanCao/settle` |
| 证明材料 | `https://github.com/IanCao/settle` (type: GitHub Repository) |

## Notes for the reviewer

- The model is invoked in exactly one step (`judge` / `resolve_dispute`). Funding,
  delivering, settling and refunding are deterministic and cost nothing.
- The payout is bound to the verdict inside the contract: a verdict of REJECT
  with a drifting 40% payout is clamped to 0, so a model cannot quietly split the
  difference.
- 29 offline tests, no network, under a second:
  `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest tests -q`
- The deployment is verifiable byte-for-byte: `node scripts/verify_deployment.mjs`
  prints `PASS DeliverableEscrow code=true schema=true exec=true storage=true`.
