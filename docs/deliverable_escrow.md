# Deliverable Escrow

**One line:** escrow whose release condition is a paragraph of prose, resolved by
a two-round adjudication where the second round is adversarial.

`contracts/deliverable_escrow.py` · GenVM `py-genlayer:1jb45aa8ynh...`

## The problem it solves

Every escrow in production settles on a binary signal: a signature, a hash, an
oracle price. That is why freelance work, grant tranches, bounties and content
licensing still settle off-chain - the real condition is "is this good enough",
and no EVM contract can read a deliverable.

This contract makes "good enough" a first-class settlement value. Acceptance is
not boolean: it is **basis points**. `ACCEPT` pays 100%, `PARTIAL` pays 50%,
`REJECT` pays 0%, and the escrow splits the balance accordingly instead of
forcing an all-or-nothing flip.

## State

```
Escrow {
  client, provider, amount, criteria, deadline, status
  deliverable, verdict, payout_bps, reasoning, judged_at     # round 1
  escalated, client_evidence, final_verdict, final_bps        # round 2
}
```

Two ledgers: `escrows: TreeMap[u256, Escrow]` and `credits: TreeMap[Address, u256]`.
All payouts go through the ledger, so a payout can never revert the judgement
that produced it.

## Lifecycle

```
create_escrow(provider, criteria, deadline_seconds)  [payable]
        |
     FUNDED --refund_expired() after deadline--> REFUNDED (client made whole)
        |
     submit_deliverable(url)   provider, one URL, overwrite = revision
        |
     DELIVERED --judge()--> JUDGED
        |                     |
        |                     +-- client silent past window --> settle()  --> SETTLED (round 1 stands)
        |                     |
        |                     +-- escalate(counter_evidence) --> DISPUTED --resolve_dispute()--> SETTLED (round 2)
```

## Why two rounds, and why they are not the same code path

**Round 1 is asymmetric.** Only the provider has a document, so the question is
one-sided: "does this artifact satisfy the criteria". The only available guard
against a hallucinated approval is independent re-derivation, so every validator
re-fetches the deliverable and re-judges it.

**Round 2 is adversarial.** Now both parties have documents on the record and the
question changes to "whose reading of the criteria is more probative". The prompt
is explicitly told not to defer to the first decision and to treat a counter
document that does not address the criteria as worth nothing. A rejection that
survives a counter-argument is a much stronger signal than one produced in a
one-sided read - which is exactly why round 2 is the one that moves disputed
money.

## How consensus is used

Both rounds call `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`:

- leader fetches the document(s), fills a fixed prompt template, requests
  `response_format="json"`, and returns a canonicalised JSON string
  (`json.dumps(..., sort_keys=True)`);
- validator independently fetches, independently judges, and accepts only if
  `verdict` matches **and** `payout_bps` is within ±10 percentage points of its
  own honest read.

Comparing a numeric settlement field with a tolerance - rather than demanding an
identical string - is what allows different validator models to agree on money
while disagreeing on wording.

`_coerce()` then closes the loop between prose and money: if the model returns a
`payout_bps` more than 25 points away from the canonical value for its own verdict
(`ACCEPT=10000`, `PARTIAL=5000`, `REJECT=0`), the canonical value wins. A drifting
model cannot turn a `REJECT` into a 40% payout.

## Prompt-injection posture

Both the criteria and the documents are untrusted (the provider picks the
deliverable URL, the client picks the counter URL). Documents are length-capped
(6000 chars), wrapped in per-party delimiters, and the prompt states that content
inside them is data, never instruction. Empty or unreachable documents cannot
satisfy anything - they fall to `REJECT`, not to a default approval.

## Why it is reusable

The pair `(criteria, deliverable) -> payout_bps` is the whole primitive.
Integrators get freelance milestones, grant tranches, bug bounties, content
licensing and SLA credits by writing different criteria - no contract change, no
frontend required. The escalation round is boilerplate-free dispute handling that
most escrow implementations either omit or push to a human.

## Tests

`tests/test_deliverable_escrow.py` covers funding guards (self-escrow, dust
amount), provider-only submission, deadline expiry and `refund_expired`, round-1
accept / partial / reject settlement splits, escalation-window enforcement,
provider-only and client-only permissions, round-2 override of a wrong round-1
rejection, validator agreement/dissent, and the money-binding rule in `_coerce`.

## Deploy

Constructor: `DeliverableEscrow(escalation_window: u256)`

```
escalation_window = 3600   # 1h on testnet; a day is sane for real work
```

Studio deploy payload: `{"args":[3600]}`. Passing `0` means "use the minimum"
(60s), so a bad unit guess cannot revert the deploy.

`withdraw()` needs a live network (ghost contract transfer); direct-mode tests
assert on `credits`.
