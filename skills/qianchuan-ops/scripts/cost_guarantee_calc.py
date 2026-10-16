#!/usr/bin/env python3
"""Offline arithmetic for documented cost-guarantee formulas; never confirms eligibility."""
import argparse
import json
import sys
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from fractions import Fraction

KINDS = {"main_roi", "boost_roi", "boost_cpa"}

def decimal_value(value, label, positive=False):
    if isinstance(value, bool) or value is None:
        raise ValueError(label + " must be a finite number")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(label + " must be a finite number") from None
    if not result.is_finite() or result < 0 or (positive and result == 0):
        raise ValueError(label + (" must be positive" if positive else " must be nonnegative"))
    return Fraction(result)

def order_value(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(label + " must be a nonnegative integer")
    return value

def text_decimal(value):
    if value is None:
        return None
    with localcontext() as context:
        context.prec = 50
        value = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    if "." in value:
        value = value.rstrip("0").rstrip(".")
    return value or "0"

def calculate(payload):
    if not isinstance(payload, dict):
        raise ValueError("input must be a JSON object")
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ValueError("kind must be main_roi, boost_roi, or boost_cpa; other products need their own rules")
    spend = decimal_value(payload.get("spend"), "spend")
    periods = payload.get("periods")
    if not isinstance(periods, list) or not periods:
        raise ValueError("periods must be a nonempty list")
    with localcontext() as context:
        context.prec = 50
        target_amount = Fraction(0)
        gmv = Fraction(0)
        orders = 0
        orders_known = True
        for index, row in enumerate(periods):
            if not isinstance(row, dict):
                raise ValueError("each period must be an object")
            target = decimal_value(row.get("target"), "period target", positive=True)
            if kind == "boost_cpa":
                count = order_value(row.get("orders"), "period orders")
                orders += count
                target_amount += target * count
            else:
                amount = decimal_value(row.get("gmv"), "period gmv")
                gmv += amount
                target_amount += amount / target
                if row.get("orders") is None:
                    orders_known = False
                else:
                    orders += order_value(row["orders"], "period orders")
        if kind == "boost_cpa":
            composite = target_amount / orders if orders else None
            actual = spend / orders if orders else None
            # Cross multiplication preserves the strict 120% boundary.
            effect_met = spend > target_amount * Fraction(6, 5) if orders else None
        else:
            composite = gmv / target_amount if target_amount else None
            actual = gmv / spend if spend else None
            # G/C < (G/T)*0.8 for positive G,C,T.
            effect_met = spend * Fraction(4, 5) > target_amount if gmv > 0 and spend > 0 else (False if spend == 0 else None)
        order_met = orders >= 10 if orders_known else None
        if order_met is False or effect_met is False:
            status = "numeric_conditions_not_met"
        elif order_met is True and effect_met is True:
            status = "numeric_conditions_met_other_checks_pending"
        else:
            status = "insufficient_numeric_information"
        difference = spend - target_amount
        conditional = max(Fraction(0), difference) if status == "numeric_conditions_met_other_checks_pending" else (Fraction(0) if status == "numeric_conditions_not_met" else None)
        return {
            "calculation_only": True,
            "kind": kind,
            "numeric_status": status,
            "total_orders": orders if orders_known else None,
            "total_gmv": text_decimal(gmv) if kind != "boost_cpa" else None,
            "total_target_amount": text_decimal(target_amount),
            "composite_target": text_decimal(composite),
            "actual_metric": text_decimal(actual),
            "order_threshold_met": order_met,
            "effect_threshold_met": effect_met,
            "formula_difference": text_decimal(difference),
            "conditional_amount_if_all_rules_satisfied": text_decimal(conditional),
            "eligibility_confirmed": False,
            "not_checked": [
                "product scope and mode history",
                "task identity, guarantee window and data freshness",
                "order attribution, refund and abnormal-order exclusions",
                "bid and targeting changes",
                "general eligibility, review and actual grant status"
            ],
            "source_ids": ["QC-OFFICIAL-015", "QC-OFFICIAL-016"],
        }

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="UTF-8 JSON file; default: stdin")
    parser.add_argument("--output", help="Optional output JSON path; default: stdout")
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8-sig")
        # Windows PowerShell can prefix piped UTF-8 JSON with a BOM.
        data = json.loads(raw.removeprefix("\ufeff"), parse_float=Decimal)
        result = calculate(data)
        rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            output = Path(args.output)
            if args.input != "-" and output.resolve() == Path(args.input).resolve():
                raise ValueError("output must not overwrite input")
            if output.exists():
                raise ValueError("output already exists; choose a new result path")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        return 0
    except (ValueError, OSError, InvalidOperation) as error:
        sys.stderr.write("Calculation not completed: " + str(error) + "\n")
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
