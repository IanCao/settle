"""Offline logic tests for DeliverableEscrow (shimmed GenVM, no network)."""

from __future__ import annotations

import json

import pytest

from helpers import ALICE, BOB, GEN, deploy_escrow

DELIVERABLE_URL = "https://provider.example/deliverable"
COUNTER_URL = "https://client.example/complaint"
CRITERIA = "A working landing page with pricing and a contact form."


def _decision(verdict="ACCEPT", bps=10000, reasoning="criteria met"):
    return json.dumps({"verdict": verdict, "payout_bps": bps, "reasoning": reasoning})


def _create(module, contract, client=ALICE, provider=BOB, amount=GEN, deadline=86400):
    module.gl.set_context(sender=client, value=amount)
    return contract.create_escrow(provider, CRITERIA, module.u256(deadline))


def _delivered(module, contract):
    escrow_id = _create(module, contract)
    module.gl.set_context(sender=BOB, value=0)
    contract.submit_deliverable(escrow_id, DELIVERABLE_URL)
    module.gl.nondet.web.mock(r"provider\.example/deliverable", "Landing page with pricing table.")
    module.gl.nondet.web.mock(r"client\.example/complaint", "No contact form exists.")
    return escrow_id


def _judged(module, contract, verdict="ACCEPT", bps=10000):
    escrow_id = _delivered(module, contract)
    module.gl.llm.mock(r"acceptance reviewer of an escrow contract", _decision(verdict, bps))
    module.gl.set_context(sender=ALICE, value=0)
    contract.judge(escrow_id)
    return escrow_id


# ------------------------------------------------------------------ deployment


def test_create_escrow_records_funding():
    module, contract = deploy_escrow()
    escrow_id = _create(module, contract)

    escrow = contract.get_escrow(escrow_id)
    assert escrow.status == "FUNDED"
    assert escrow.amount == GEN
    assert escrow.client == ALICE
    assert escrow.provider == BOB
    assert contract.escrow_count() == 1


def test_create_rejects_self_escrow():
    module, contract = deploy_escrow()
    module.gl.set_context(sender=ALICE, value=GEN)
    with pytest.raises(module.gl.vm.UserError, match="must differ"):
        contract.create_escrow(ALICE, CRITERIA, module.u256(86400))


def test_create_rejects_dust_amount():
    module, contract = deploy_escrow()
    module.gl.set_context(sender=ALICE, value=1)
    with pytest.raises(module.gl.vm.UserError, match="below the minimum"):
        contract.create_escrow(BOB, CRITERIA, module.u256(86400))


def test_create_rejects_empty_criteria():
    module, contract = deploy_escrow()
    module.gl.set_context(sender=ALICE, value=GEN)
    with pytest.raises(module.gl.vm.UserError, match="criteria is empty"):
        contract.create_escrow(BOB, "   ", module.u256(86400))


def test_create_rejects_zero_deadline():
    module, contract = deploy_escrow()
    module.gl.set_context(sender=ALICE, value=GEN)
    with pytest.raises(module.gl.vm.UserError, match="future"):
        contract.create_escrow(BOB, CRITERIA, module.u256(0))


def test_escalation_window_has_a_floor():
    mod = __import__("helpers").load_contract("contracts/deliverable_escrow.py")
    with pytest.raises(mod.gl.vm.UserError, match="below the minimum"):
        mod.DeliverableEscrow(mod.u256(1))


def test_zero_escalation_window_means_use_the_minimum():
    mod = __import__("helpers").load_contract("contracts/deliverable_escrow.py")
    contract = mod.DeliverableEscrow(mod.u256(0))
    assert int(contract.escalation_window) == int(mod.MIN_ESCALATION_WINDOW)


# ------------------------------------------------------------------ submission


def test_only_provider_can_submit():
    module, contract = deploy_escrow()
    escrow_id = _create(module, contract)

    module.gl.set_context(sender=ALICE, value=0)
    with pytest.raises(module.gl.vm.UserError, match="only the provider"):
        contract.submit_deliverable(escrow_id, DELIVERABLE_URL)


def test_submission_requires_http_url():
    module, contract = deploy_escrow()
    escrow_id = _create(module, contract)

    module.gl.set_context(sender=BOB, value=0)
    with pytest.raises(module.gl.vm.UserError, match="http"):
        contract.submit_deliverable(escrow_id, "ipfs://bafy")


def test_submission_moves_escrow_to_delivered():
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)

    assert contract.get_escrow(escrow_id).status == "DELIVERED"
    assert contract.get_escrow(escrow_id).deliverable == DELIVERABLE_URL


def test_cannot_judge_before_submission():
    module, contract = deploy_escrow()
    escrow_id = _create(module, contract)

    with pytest.raises(module.gl.vm.UserError, match="nothing to judge"):
        contract.judge(escrow_id)


# ------------------------------------------------------------- round one judge


def test_accept_pays_the_full_amount():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "ACCEPT", 10000)

    escrow = contract.get_escrow(escrow_id)
    assert escrow.status == "JUDGED"
    assert escrow.payout_bps == 10000
    assert contract.quote_payout(escrow_id) == GEN


def test_partial_keeps_half_in_escrow():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "PARTIAL", 5000)

    assert contract.get_escrow(escrow_id).payout_bps == 5000
    assert contract.quote_payout(escrow_id) == GEN // 2


def test_reject_quotes_zero():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    assert contract.quote_payout(escrow_id) == 0


def test_unknown_verdict_is_rejected():
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)
    module.gl.llm.mock(r"acceptance reviewer of an escrow contract", _decision("MAYBE", 5000))

    with pytest.raises(module.gl.vm.UserError, match="invalid verdict"):
        contract.judge(escrow_id)


def test_validator_dissent_blocks_the_judgement():
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)
    module.gl.llm.queue(
        r"acceptance reviewer of an escrow contract",
        [_decision("ACCEPT", 10000), _decision("REJECT", 0)],
    )

    with pytest.raises(module.gl.vm.UserError, match="consensus"):
        contract.judge(escrow_id)
    assert contract.get_escrow(escrow_id).status == "DELIVERED"


def test_payout_is_bound_to_the_verdict():
    """A drifting model cannot split a REJECT into a 40% payout."""
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 4000)

    assert contract.get_escrow(escrow_id).payout_bps == 0


def test_small_payout_drift_is_tolerated():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "PARTIAL", 5500)

    assert contract.get_escrow(escrow_id).payout_bps == 5500


# ------------------------------------------------------------------ escalation


def test_only_client_can_escalate():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=BOB, value=0)
    with pytest.raises(module.gl.vm.UserError, match="only the client"):
        contract.escalate(escrow_id, COUNTER_URL)


def test_escalation_requires_a_judged_escrow():
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)

    module.gl.set_context(sender=ALICE, value=0)
    with pytest.raises(module.gl.vm.UserError, match="nothing to escalate"):
        contract.escalate(escrow_id, COUNTER_URL)


def test_escalation_marks_escrow_disputed():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=ALICE, value=0)
    contract.escalate(escrow_id, COUNTER_URL)

    escrow = contract.get_escrow(escrow_id)
    assert escrow.status == "DISPUTED"
    assert escrow.escalated is True
    assert escrow.client_evidence == COUNTER_URL


# ------------------------------------------------------------- round two appeal


def test_appeal_can_override_a_wrong_rejection():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=ALICE, value=0)
    contract.escalate(escrow_id, COUNTER_URL)

    module.gl.llm.mock(r"appeal reviewer of an escrow contract", _decision("ACCEPT", 10000, "counter doc shows the form exists"))
    contract.resolve_dispute(escrow_id)

    escrow = contract.get_escrow(escrow_id)
    assert escrow.status == "SETTLED"
    assert escrow.final_verdict == "ACCEPT"
    assert escrow.final_bps == 10000
    assert contract.get_credit(BOB) == GEN
    assert contract.get_credit(ALICE) == 0


def test_appeal_can_confirm_the_rejection():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=ALICE, value=0)
    contract.escalate(escrow_id, COUNTER_URL)

    module.gl.llm.mock(r"appeal reviewer of an escrow contract", _decision("REJECT", 0, "counter doc is unrelated"))
    contract.resolve_dispute(escrow_id)

    assert contract.get_credit(ALICE) == GEN
    assert contract.get_credit(BOB) == 0


def test_partial_appeal_splits_the_escrow():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=ALICE, value=0)
    contract.escalate(escrow_id, COUNTER_URL)

    module.gl.llm.mock(r"appeal reviewer of an escrow contract", _decision("PARTIAL", 5000, "half the criteria met"))
    contract.resolve_dispute(escrow_id)

    assert contract.get_credit(BOB) == GEN // 2
    assert contract.get_credit(ALICE) == GEN // 2


def test_appeal_prompt_carries_both_documents():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "REJECT", 0)

    module.gl.set_context(sender=ALICE, value=0)
    contract.escalate(escrow_id, COUNTER_URL)
    module.gl.llm.mock(r"appeal reviewer of an escrow contract", _decision("PARTIAL", 5000))
    contract.resolve_dispute(escrow_id)

    prompt = module.gl.llm.calls[-1]
    assert "<<<PROVIDER" in prompt
    assert "<<<CLIENT" in prompt
    assert "Landing page with pricing table." in prompt
    assert "No contact form exists." in prompt


def test_placeholder_in_a_document_cannot_shift_the_evidence():
    """A provider document containing '{DOC_B}' must not swallow the appeal's
    counter evidence - prompts are concatenated, never placeholder-substituted."""
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)
    module.gl.nondet.web.clear()
    module.gl.nondet.web.mock(r"provider\.example/deliverable", "PROVIDER-TEXT {DOC_B} PROVIDER-TEXT")
    module.gl.nondet.web.mock(r"client\.example/complaint", "CLIENT-MARKER")
    module.gl.llm.mock(r"acceptance reviewer of an escrow contract", _decision("REJECT", 0))
    module.gl.set_context(sender=ALICE, value=0)
    contract.judge(escrow_id)
    contract.escalate(escrow_id, COUNTER_URL)

    module.gl.llm.mock(r"appeal reviewer of an escrow contract", _decision("PARTIAL", 5000))
    contract.resolve_dispute(escrow_id)

    prompt = module.gl.llm.calls[-1]
    assert prompt.index("PROVIDER-TEXT {DOC_B} PROVIDER-TEXT") < prompt.index("CLIENT-MARKER")


def test_resolve_requires_a_dispute():
    module, contract = deploy_escrow()
    escrow_id = _judged(module, contract, "ACCEPT", 10000)

    with pytest.raises(module.gl.vm.UserError, match="not disputed"):
        contract.resolve_dispute(escrow_id)


# ------------------------------------------------------------------- refunds


def test_refund_needs_the_deadline_to_pass():
    module, contract = deploy_escrow()
    escrow_id = _create(module, contract, deadline=86400)

    with pytest.raises(module.gl.vm.UserError, match="deadline not reached"):
        contract.refund_expired(escrow_id)


def test_refund_requires_an_undelivered_escrow():
    module, contract = deploy_escrow()
    escrow_id = _delivered(module, contract)

    with pytest.raises(module.gl.vm.UserError, match="already moved past funding"):
        contract.refund_expired(escrow_id)
