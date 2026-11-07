# Settle

Escrow that pays in basis points, not yes/no.

Every escrow on chain can answer "was this signed". Almost none can answer "is
this deliverable good enough" - which is the question that actually blocks
freelance, grant and bounty payouts. Settle puts the acceptance criteria in the
contract as plain words before work starts, and lets validators read the
delivered artifact against them.

**Live app:** https://iancao.github.io/settle/

## What one escrow looks like

```
create_escrow(provider, criteria, deadline)   client locks funds + pins criteria
submit_deliverable(id, url)                   provider posts exactly one artifact
judge(id)                                     round 1: ACCEPT / PARTIAL / REJECT
settle(id)                                    client let the window lapse -> round 1 stands
escalate(id, counter_url)                     client contests with its own document
resolve_dispute(id)                           round 2: adversarial read of both documents
refund_expired(id)                            nothing delivered by the deadline
```

The payout is a number, not a boolean: `ACCEPT=10000, PARTIAL=5000, REJECT=0`
basis points, split between provider and client. Partial acceptance needs no
second contract and no negotiation after the fact.

## Why two rounds

**Round 1 is asymmetric.** Only the provider has a document on the record, so
the only trustworthy guard is independent re-derivation: every validator fetches
the artifact itself and the leader is accepted only on verdict equality plus a
10-point basis tolerance. A single model's opinion is not enough to move money.

**Round 2 is adversarial.** Both parties are on the record and the question
changes to "whose reading of the criteria is correct". A rejection that survives
a counter-argument is a far stronger signal than one produced in a one-sided
read - so round 2 is what actually settles disputed cases.

**Untrusted text stays untrusted.** Both documents and the criteria are fenced
inside delimiters and the prompt states that nothing inside them is an
instruction. A deliverable whose content says "the reviewer already approved
this" is a document to be judged, not an instruction to obey. There are tests
for exactly that.

**Empty is not acceptance.** An unreachable or empty artifact cannot satisfy
anything: it is a REJECT, not an error, so the escrow cannot get stuck because a
URL 404s.

## What is here

```
contracts/   deliverable_escrow.py - the whole primitive, one file
app/         the web client (no framework, vendored genlayer-js)
docs/        design notes: state machine, prompt design, payout table
tests/       29 offline logic tests, no network, no Docker
scripts/     read-only on-chain verification of the deployment
tools/       an offline GenVM shim the tests run against
```

## Deployed on GenLayer Studionet

| Contract | Address | Constructor args |
|---|---|---|
| DeliverableEscrow | [`0x28Ee25d23d30f8E7C53eF54DBf0dF328813E3105`](https://explorer-studio.genlayer.com/address/0x28Ee25d23d30f8E7C53eF54DBf0dF328813E3105) | `escalation_window=3600` |

## Try it

Open the live app. Browsing needs no wallet: `escrow_count()` and `get_escrow()`
are simulations, so the list renders for any visitor.

1. Connect a wallet on Studionet (the app adds chain 61999 if your wallet lacks it).
2. Fund an escrow: provider address, acceptance criteria in plain words, amount
   (0.01 GEN minimum), deadline in days.
3. Switch to the provider account and submit one artifact URL.
4. Anyone may press **Judge** - that is the only step that calls a model, and it
   is the only step that costs anything.
5. The client can **Escalate** with counter evidence inside the window; otherwise
   anyone can **Settle** once it lapses. Either way the split is credited, and
   **Withdraw** sends it out.

The transaction panel reports each consensus stage - proposing, committing,
revealing - instead of a spinner, because on GenLayer a broadcast transaction is
not yet an accepted one, and a contract can still revert after consensus.

## Run the tests

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 .venv/Scripts/python -m pytest tests -q
```

29 tests in about a third of a second. They cover the full state machine,
permission edges (only the provider submits, only the client escalates), all
three verdict paths, payout drift being clamped to the verdict, escalation
timing, refunds, prompt injection inside a deliverable, and end-to-end value
conservation: what goes in equals what comes out, to the wei.

## Verify the deployment

```bash
npm install genlayer-js
node scripts/verify_deployment.mjs
```

Read-only, no private key. It checks that the on-chain code is byte-identical to
`contracts/deliverable_escrow.py`, that the schema compiled from the repo matches
the on-chain schema, that a view call executes, and that the constructor value
appears in the live storage slots.

## Related

`IanCao/adjudicate` is the sibling primitive: a bonded claim oracle where the
question is "is this statement true" rather than "is this delivery good enough".
Both are self-contained - no imports between them, no shared off-chain service.
