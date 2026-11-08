"""
Калькулятор без eval().

Почему не eval("2+2"): eval выполняет ЛЮБОЙ код Python — модель (или текст, который
ей подсунули) могла бы написать __import__('os').system('...'). Поэтому мы разбираем
выражение в дерево (модуль ast) и сами вычисляем только разрешённые узлы:
числа, + − × ÷, степень, скобки и функции из белого списка.

Защита от «вечных» вычислений: 9**9**9 посчиталось бы за часы и съело всю память,
поэтому степень и факториал ограничены.
"""

import ast
import math
import operator
import re

MAX_EXPONENT = 10_000
MAX_FACTORIAL = 1_000
MAX_EXPRESSION_CHARS = 500
MAX_RESULT_BITS = 16_610  # ≈ 5000 десятичных цифр

BIN_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
}
UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
CONSTANTS = {"pi": math.pi, "π": math.pi, "e": math.e, "tau": math.tau}


def _factorial(n):
    if not float(n).is_integer() or n < 0:
        raise ValueError("факториал определён только для целых чисел ≥ 0")
    if n > MAX_FACTORIAL:
        raise ValueError(f"слишком большой факториал (максимум {MAX_FACTORIAL}!)")
    return math.factorial(int(n))


FUNCTIONS = {
    "sqrt": math.sqrt, "cbrt": lambda x: math.copysign(abs(x) ** (1 / 3), x),
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "ln": math.log, "log": lambda x, base=10: math.log(x, base), "log2": math.log2, "log10": math.log10,
    "exp": math.exp, "abs": abs, "round": round, "floor": math.floor, "ceil": math.ceil,
    "factorial": _factorial, "min": min, "max": max, "gcd": math.gcd, "lcm": math.lcm,
    "radians": math.radians, "degrees": math.degrees,
}


class CalcError(ValueError):
    pass


def normalize(expression: str) -> str:
    """Привычная запись → синтаксис Python: 2^3 → 2**3, 3×4 → 3*4, 2,5 → 2.5, √9 → sqrt(9)."""
    expr = expression.strip()
    expr = expr.replace("^", "**").replace("×", "*").replace("·", "*").replace("÷", "/").replace("−", "-")
    expr = re.sub(r"(\d),(\d)", r"\1.\2", expr)  # десятичная запятая (но не «max(1, 2)» — там пробел)
    expr = re.sub(r"√\s*(\d+(?:\.\d+)?|\([^()]*\))", r"sqrt(\1)", expr)
    expr = re.sub(r"(\d+(?:\.\d+)?)!", r"factorial(\1)", expr)
    return expr


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in BIN_OPS:
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > MAX_EXPONENT:
            raise CalcError(f"слишком большая степень (максимум {MAX_EXPONENT})")
        if isinstance(node.op, ast.Pow) and isinstance(left, int) and isinstance(right, int) and right > 0 \
                and abs(left) > 1 and right * math.log10(abs(left)) > 5000:
            raise CalcError("результат получился бы длиннее 5000 цифр")
        result = BIN_OPS[type(node.op)](left, right)
        # Каждая степень по отдельности могла пройти проверку, а произведение — нет: 10**4000 * 10**4000
        if isinstance(result, int) and result.bit_length() > MAX_RESULT_BITS:
            raise CalcError("результат получился бы длиннее 5000 цифр")
        return result
    if isinstance(node, ast.UnaryOp) and type(node.op) in UNARY_OPS:
        return UNARY_OPS[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.Name) and node.id in CONSTANTS:
        return CONSTANTS[node.id]
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUNCTIONS and not node.keywords:
        return FUNCTIONS[node.func.id](*[_eval(a) for a in node.args])
    # Всё остальное (атрибуты, импорт, строки, списки...) запрещено
    raise CalcError(f"недопустимая часть выражения: {ast.dump(node)[:60]}")


def format_number(value) -> str:
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return f"{value:.12g}"
    return str(value)


def calculate(expression: str) -> dict:
    if len(expression) > MAX_EXPRESSION_CHARS:
        raise CalcError("слишком длинное выражение")
    expr = normalize(expression)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise CalcError(f"не понимаю выражение «{expression}»") from e
    try:
        value = _eval(tree)
    except ZeroDivisionError as e:
        raise CalcError("деление на ноль") from e
    except (ValueError, OverflowError, TypeError) as e:
        raise CalcError(str(e)) from e
    return {"expression": expression, "result": format_number(value)}
