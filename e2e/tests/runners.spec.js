// Every runnable language, end to end: the Hello World starter, a second
// program with a known answer, and a broken program that must report its
// error (rather than hang or show nothing).
const { test, expect } = require('@playwright/test');
const { openRoom, waitLive, setCode, run, storedText } = require('./helpers');

const languages = {
  javascript: {
    hello: /Hello, World!/,
    program: 'const xs = [1, 2, 3, 4];\nconsole.log(xs.map(x => x * x).reduce((a, b) => a + b));',
    expected: /30/,
    broken: 'console.log(nope.x)',
    error: /nope|not defined|ReferenceError/i,
  },
  typescript: {
    hello: /Hello, World!/,
    // Types are stripped (line-preservingly, by Babel in the debug
    // worker), then the result runs exactly like a JavaScript paste
    // (QuickJS).
    program: 'function square(n: number): number {\n  return n * n;\n}\nconst xs: number[] = [1, 2, 3, 4];\nconsole.log(xs.map(square).reduce((a, b) => a + b, 0));',
    expected: /30/,
    broken: 'console.log(nope.x)',
    error: /nope|not defined|ReferenceError/i,
  },
  python: {
    hello: /Hello, World!/,
    program: 'import math\nprint(sum(i * i for i in range(5)), math.factorial(5))',
    expected: /30 120/,
    broken: 'print(1/0)',
    error: /ZeroDivisionError/,
  },
  ruby: {
    hello: /Hello, World!/,
    program: 'puts (1..5).map { |x| x * x }.sum\nputs "ab".upcase',
    expected: /55[\s\S]*AB/,
    broken: 'puts undefined_thing',
    error: /undefined|NameError/i,
  },
  scheme: {
    hello: /Hello, World!/,
    program: '(define (fact n) (if (<= n 1) 1 (* n (fact (- n 1)))))\n(display (fact 10))\n(newline)\n(display (map (lambda (x) (* x x)) (list 1 2 3)))',
    expected: /3628800\s+\(1 4 9\)/,
    broken: '(display "before")\n(car 5)',
    // Output printed before the error is kept, and the error is reported.
    error: /before[\s\S]*car/,
  },
  clojure: {
    hello: /Hello, World!/,
    program: '(defn fact [n] (if (<= n 1) 1 (* n (fact (dec n)))))\n(println (reduce + (map #(* % %) [1 2 3 4])))\n(fact 10)',
    // 30 printed, then the value of the last form REPL-style.
    expected: /30[\s\S]*Result:[\s\S]*3628800/,
    broken: '(println "before")\n(nth [1 2] 5)',
    // Output printed before the error is kept, and the error cites the line.
    error: /before[\s\S]*No item 5[\s\S]*line 2/,
  },
  shell: {
    hello: /Hello, World!/,
    program: 'for i in 1 2 3; do echo "n=$i"; done\necho $((6*7))',
    expected: /n=1[\s\S]*n=3[\s\S]*42/,
    broken: 'nosuchcommand_xyz',
    error: /not found|nosuchcommand/i,
  },
  cpp: {
    hello: /Hello, World!/,
    program: '#include <iostream>\n#include <vector>\nint main() {\n  std::vector<int> v{1, 2, 3};\n  int s = 0;\n  for (int x : v) s += x * x;\n  std::cout << "sum=" << s << std::endl;\n  return 0;\n}',
    expected: /sum=14/,
    broken: '#include <iostream>\nint main() { std::cout << undefined_var; }',
    error: /error|undeclared/i,
  },
  jsx: {
    hello: /Hello, World!/,
    program: 'function App() {\n  const [n] = React.useState(41);\n  return <p>count is {n + 1}</p>;\n}',
    expected: /count is 42/,
    broken: 'function App() { return <p>{oops.y}</p>; }',
    error: /oops|error/i,
  },
  mermaid: {
    hello: /Hello, World!/,
    program: 'sequenceDiagram\n    Alice->>Bob: ping\n    Bob-->>Alice: pong',
    expected: /ping[\s\S]*pong/,
    broken: 'flowchart LR\n  A --> --> B ((',
    error: /error|parse/i,
  },
  minizinc: {
    hello: /Hello, World!/,
    program: 'var 1..10: x;\nvar 1..10: y;\nconstraint x + y = 7;\nconstraint x * y = 12;\nconstraint x < y;\nsolve satisfy;\noutput ["x=\\(x) y=\\(y)\\n"];',
    expected: /x=3 y=4/,
    broken: 'var 1..3: x;\nconstraint x > 5;\nsolve satisfy;',
    error: /unsatisfiable|no solution/i,
  },
  ocaml: {
    hello: /Hello, World!/,
    program: 'let rec fact n = if n <= 1 then 1 else n * fact (n - 1)\n\nlet () =\n  let xs = [1; 2; 3; 4] in\n  Printf.printf "%d %d\\n" (List.fold_left (fun a x -> a + x * x) 0 xs) (fact 5)',
    expected: /30 120/,
    broken: 'let () = print_endline (string_of_int "nope")',
    error: /has type string|Error/,
  },
  picat: {
    hello: /Hello, World!/,
    program: 'import cp.\nmain =>\n    X :: 1..10, Y :: 1..10,\n    X + Y #= 7, X * Y #= 12, X #< Y,\n    solve([X,Y]),\n    printf("x=%w y=%w%n", X, Y).',
    expected: /x=3 y=4/,
    broken: 'main => foo_undefined(1).',
    error: /undefined|foo_undefined/i,
  },
  tlaplus: {
    // The starter is the missionaries-and-cannibals river crossing: the
    // Solution invariant is deliberately violated, and the trace is the answer.
    hello: /Model checking failed: InvariantViolation[\s\S]*Counterexample trace/,
    program: '---- MODULE Counter ----\nEXTENDS Integers\nVARIABLE x\nInit == x = 0\nNext == x < 3 /\\ x\' = x + 1\nSmall == x <= 3\n====\n\n---- CONFIG ----\nINIT Init\nNEXT Next\nINVARIANTS\n  Small\n====\n',
    // x stops at 3: four states, then no next step.
    expected: /Deadlock[\s\S]*States explored: 4/,
    broken: '---- MODULE Counter ----\nEXTENDS Integers\nVARIABLE x\nInit == x = 0\nNext == x\' = x + 1\nSmall == x <= 2\n====\n\n---- CONFIG ----\nINIT Init\nNEXT Next\nINVARIANTS\n  Small\n====\n',
    error: /InvariantViolation|violated/i,
  },
};

for (const [lang, spec] of Object.entries(languages)) {
  test.describe(lang, () => {
    test('Hello World starter runs', async ({ page }) => {
      await openRoom(page, lang);
      await expect(page.locator('#helloWorldButton')).toBeVisible();
      await page.click('#helloWorldButton');
      expect(await run(page)).toMatch(spec.hello);
    });

    test('runs a program and saves it', async ({ page }) => {
      await openRoom(page, lang);
      await setCode(page, spec.program);
      expect(await run(page)).toMatch(spec.expected);
      await waitLive(page);
      await expect.poll(() => storedText(page), { timeout: 15_000 }).toBe(spec.program);
    });

    test('reports an error for a broken program', async ({ page }) => {
      await openRoom(page, lang);
      await setCode(page, spec.broken);
      // Errors must come back promptly, not after a long timeout.
      const started = Date.now();
      expect(await run(page)).toMatch(spec.error);
      if (lang === 'scheme') expect(Date.now() - started).toBeLessThan(20_000);
    });
  });
}

// TypeScript's type stripper keeps every statement on its original line,
// so a runtime error's stack cites the source's line numbers even though
// type-only lines (the interface) were removed above it.
test('typescript runtime errors carry source line numbers', async ({ page }) => {
  await openRoom(page, 'typescript');
  await setCode(page, [
    'interface Foo {',
    '  x: number;',
    '}',
    '',
    'function boom(f: Foo): void {',
    "  throw new Error('kaboom ' + f.x);",
    '}',
    '',
    'boom({ x: 1 });',
  ].join('\n'));
  const out = await run(page);
  expect(out).toMatch(/kaboom 1/);
  expect(out).toMatch(/program:6/);
  expect(out).toMatch(/program:9/);
});

// The ES2025 iterator helpers (map/filter/flatMap/take/drop/toArray/… on
// generators and other iterators) work on plain runs: the self-hosted
// quickjs-ng runtime ships them, where the old wasmedge_quickjs build
// threw "TypeError: not a function" (issue #75).
for (const lang of ['javascript', 'typescript']) {
  test(`${lang} supports ES2025 iterator helpers on generators`, async ({ page }) => {
    const ann = lang === 'typescript' ? ': number' : '';
    await openRoom(page, lang);
    await setCode(page, [
      `function* fibs(n${ann}) {`,
      '    let [a, b] = [0, 1];',
      '    for (let i = 0; i < n; i++) {',
      '        yield a;',
      '        [a, b] = [b, a + b];',
      '    }',
      '}',
      '',
      `function* keepEven(x${ann}) {`,
      '    if (x % 2 === 0) yield x;',
      '}',
      '',
      'fibs(10).flatMap(keepEven).forEach(x => console.log(x));',
      'console.log(fibs(10).drop(1).take(4).toArray().join(","));',
    ].join('\n'));
    const out = await run(page);
    expect(out).toMatch(/0\n2\n8\n34/);
    expect(out).toMatch(/1,1,2,3/);
  });
}

// Python runs on Pyodide, which downloads imported packages that ship with
// its distribution (numpy, scipy, pandas, ...) before the run.
test('python imports scipy from the Pyodide distribution', async ({ page }) => {
  await openRoom(page, 'python');
  await setCode(page, [
    'import numpy as np',
    'from scipy import linalg',
    'a = np.array([[1.0, 2.0], [3.0, 4.0]])',
    'print("det =", round(float(linalg.det(a))))',
  ].join('\n'));
  expect(await run(page)).toMatch(/det = -2/);
});

test('every runnable language in the picker has a Hello World starter and a test', async ({ page }) => {
  await openRoom(page);
  const runnable = await page.evaluate(() =>
    Array.from(document.getElementById('languageSelect').options)
      .filter((o) => o.textContent.trim().startsWith('▶'))
      .map((o) => o.value));
  const starters = await page.evaluate(() => Object.keys(window.PbinHelloWorld));
  expect(runnable.sort()).toEqual(Object.keys(languages).sort());
  expect(starters.sort()).toEqual(Object.keys(languages).sort());
});
