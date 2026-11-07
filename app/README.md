# Settle - the web client

One page, no framework, no build step to run it. It talks to `DeliverableEscrow`
through `genlayer-js` (vendored), so it can be opened by someone who is not going
to write a script.

```
index.html      structure
styles.css      the stylesheet, no framework
app.js          client: state machine, permissions, transaction lifecycle
vendor/         genlayer-js 1.1.8 bundled with esbuild (~600 KB)
logo.png        512x512 project mark
```

## The live URL

**https://iancao.github.io/settle/**

GitHub Pages serves the `gh-pages` branch, whose tree is exactly this directory
plus a `.nojekyll` marker. After changing anything here, republish:

```bash
bash scripts/publish_app.sh
```

Editing `app/` without running it changes the repo but not the site.

## Run it locally

Any static server works; ES modules need `http://`, not `file://`:

```bash
cd app
python -m http.server 8080
# open http://localhost:8080
```

## What it actually does

**Reads never need a wallet.** `escrow_count()` and `get_escrow(id)` are `gen_call`
simulations against Studionet, so the whole list renders for any visitor,
including the Steward reviewing it.

**Writes go through the full lifecycle.** `create_escrow` (payable),
`submit_deliverable`, `judge`, `escalate`, `resolve_dispute`, `settle`,
`refund_expired` and `withdraw` are signed through the injected wallet. The panel
in the bottom right reports each stage rather than showing a spinner:

```
waiting for your signature  ->  submitted  ->  in consensus · proposing
                            ->  in consensus · committing
                            ->  in consensus · revealing
                            ->  accepted in Ns   (or: rejected: <revert text>)
```

That distinction matters on GenLayer: a broadcast transaction is not an accepted
one, and a contract can still revert after consensus.

**Permissions are shown, not enforced by hiding.** The provider sees
"Submit deliverable"; the client sees "Escalate" only while the window is open;
everyone else sees "Judge" or "Settle", which anyone may call. A button that
would revert is not rendered, but the contract is still the authority - the UI
only mirrors what `sender_address` checks will accept.

**The escalation window is read from the deployment.** `DeliverableEscrow` has no
public getter for `escalation_window`, so the client uses the deployed value
(3600s). If you deploy with a different window, change `ESCALATION_WINDOW` at the
top of `app.js` - `settle()` on chain is the real gate either way.

**No client-side money arithmetic.** The amount is parsed digit-exact into wei
(`0.05` -> `50000000000000000n`) and sent as `value`; the split, the basis points
and the credit all come from the contract. `quote_payout()` exists for anything
that needs a preview.
