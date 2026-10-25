// "Hello, World!" starters for every runnable language: each one defines a
// function and calls it to print the greeting (or the closest equivalent).
// TLA+ is the exception: its starter is the classic missionaries-and-cannibals
// river-crossing puzzle, where the invariant-violation trace is the solution.
(function () {
  'use strict';

  window.PbinHelloWorld = {
    cpp: `#include <iostream>
#include <string>

void greet(const std::string& name) {
    std::cout << "Hello, " << name << "!" << std::endl;
}

int main() {
    greet("World");
    return 0;
}
`,
    javascript: `function greet(name) {
  console.log(\`Hello, \${name}!\`);
}

greet("World");
`,
    typescript: `function greet(name: string): void {
  console.log(\`Hello, \${name}!\`);
}

greet("World");
`,
    jsx: `function Greeting({ name }) {
  return <h1>Hello, {name}!</h1>;
}

function App() {
  return <Greeting name="World" />;
}
`,
    mermaid: `flowchart LR
    main["main()"] -->|"greet('World')"| greet["greet(name)"]
    greet --> out(["Hello, World!"])
`,
    minizinc: `function string: greet(string: name) = "Hello, " ++ name ++ "!";

solve satisfy;

output [greet("World"), "\\n"];
`,
    ocaml: `let greet name =
  Printf.printf "Hello, %s!\\n" name

let () = greet "World"
`,
    picat: `main =>
    greet("World").

greet(Name) =>
    printf("Hello, %s!%n", Name).
`,
    python: `def greet(name):
    print(f"Hello, {name}!")


greet("World")
`,
    ruby: `def greet(name)
  puts "Hello, #{name}!"
end

greet("World")
`,
    scheme: `(define (greet name)
  (display (string-append "Hello, " name "!"))
  (newline))

(greet "World")
`,
    clojure: `(defn greet [name]
  (println (str "Hello, " name "!")))

(greet "World")
`,
    shell: `greet() {
  echo "Hello, $1!"
}

greet "World"
`,
    tlaplus: `---- MODULE MissionariesAndCannibals ----
EXTENDS Integers, FiniteSets

CONSTANTS Missionaries, Cannibals

VARIABLES bank_of_boat, who_is_on_bank

TypeOK == /\\ bank_of_boat \\in {"E","W"}
          /\\ who_is_on_bank \\in
                [{"E","W"} -> SUBSET (Cannibals \\cup Missionaries)]

Init == /\\ bank_of_boat = "E"
        /\\ who_is_on_bank = [i \\in {"E","W"} |->
                               IF i = "E" THEN Cannibals \\cup Missionaries
                                          ELSE {} ]

IsSafe(S) == \\/ S \\subseteq Cannibals
             \\/ Cardinality(S \\cap Cannibals) =< Cardinality(S \\cap Missionaries)

OtherBank(b) == IF b = "E" THEN "W" ELSE "E"

Move(S,b) == /\\ Cardinality(S) \\in {1,2}
             /\\ LET newThisBank  == who_is_on_bank[b] \\ S
                    newOtherBank == who_is_on_bank[OtherBank(b)] \\cup S
                IN  /\\ IsSafe(newThisBank)
                    /\\ IsSafe(newOtherBank)
                    /\\ bank_of_boat' = OtherBank(b)
                    /\\ who_is_on_bank' =
                         [i \\in {"E","W"} |-> IF i = b THEN newThisBank
                                                       ELSE newOtherBank]

Next == \\E S \\in SUBSET who_is_on_bank[bank_of_boat] :
            Move(S, bank_of_boat)

\\* The error trace when this invariant is violated is a solution.
Solution == who_is_on_bank["E"] /= {}

====

---- CONFIG ----
CONSTANTS
  Missionaries = {m1, m2, m3}
  Cannibals = {c1, c2, c3}

INIT Init
NEXT Next

INVARIANTS
  TypeOK
  Solution
====
`
  };

  // "Echo Input" starters: read the Input tab (the program's stdin) and
  // print it back, for every language whose runner supports stdin. Each
  // entry carries the code and a sample stdin text for the Input tab.
  const echoInput = 'Hello from the Input tab!\nIt was sent to stdin.\n';

  window.PbinEchoStdin = {
    cpp: {
      input: echoInput,
      code: `#include <iostream>
#include <string>

void echo(std::istream& in) {
    std::string line;
    while (std::getline(in, line)) {
        std::cout << "you said: " << line << std::endl;
    }
}

int main() {
    echo(std::cin);
    return 0;
}
`,
    },
    javascript: {
      input: echoInput,
      code: `import * as std from 'std';

function echo(input) {
  let line;
  while ((line = input.getline()) !== null) {
    console.log('you said:', line);
  }
}

echo(std.in);
`,
    },
    typescript: {
      input: echoInput,
      code: `import * as std from 'std';

function echo(input: typeof std.in): void {
  let line: string | null;
  while ((line = input.getline()) !== null) {
    console.log('you said:', line);
  }
}

echo(std.in);
`,
    },
    minizinc: {
      // MiniZinc reads the Input tab as .dzn data rather than stdin.
      input: 'n = 42;\n',
      code: `int: n;

solve satisfy;

output ["n from the Input tab = \\(n)\\n"];
`,
    },
    picat: {
      input: echoInput,
      code: `main =>
    L = read_line(),
    while (L != end_of_file)
        printf("you said: %s%n", L),
        L := read_line()
    end.
`,
    },
    python: {
      input: echoInput,
      code: `import sys


def echo(stream):
    for line in stream:
        print("you said:", line.rstrip("\\n"))


echo(sys.stdin)
`,
    },
    ruby: {
      input: echoInput,
      code: `def echo(io)
  io.each_line do |line|
    puts "you said: #{line.chomp}"
  end
end

echo($stdin)
`,
    },
    scheme: {
      input: echoInput,
      code: `(define (echo)
  (let ((line (read-line)))
    (if (eof-object? line)
        #t
        (begin
          (display (string-append "you said: " line))
          (newline)
          (echo)))))

(echo)
`,
    },
    clojure: {
      input: echoInput,
      code: `(loop []
  (when-let [line (read-line)]
    (println (str "you said: " line))
    (recur)))
`,
    },
    shell: {
      input: echoInput,
      code: `while read -r line; do
  echo "you said: $line"
done
`,
    },
  };

  // "Parse JSON" starters: read JSON from the Input tab, parse it with a
  // real JSON parser, and print each key and value. Scheme and Clojure
  // borrow the browser's JSON.parse through their js interop, and MiniZinc
  // receives the JSON as native model data (the runner feeds it to the
  // solver). C++, Shell and Picat have no JSON library in their runtimes,
  // so they get no starter.
  const jsonInput = '{"name": "pbin", "stars": 42, "wasm": true}\n';

  window.PbinJsonStdin = {
    javascript: {
      input: jsonInput,
      code: `import * as std from 'std';

let text = '';
let line;
while ((line = std.in.getline()) !== null) {
  text += line;
}

const obj = JSON.parse(text);
for (const [key, value] of Object.entries(obj)) {
  console.log(\`\${key} = \${value}\`);
}
`,
    },
    typescript: {
      input: jsonInput,
      code: `import * as std from 'std';

let text = '';
let line: string | null;
while ((line = std.in.getline()) !== null) {
  text += line;
}

const obj: Record<string, unknown> = JSON.parse(text);
for (const [key, value] of Object.entries(obj)) {
  console.log(\`\${key} = \${value}\`);
}
`,
    },
    minizinc: {
      // The Input tab's JSON becomes the model's data, so the declared
      // names must match the JSON keys.
      input: jsonInput,
      code: `string: name;
int: stars;
bool: wasm;

solve satisfy;

output [
  "name = ", name, "\\n",
  "stars = \\(stars)\\n",
  "wasm = \\(wasm)\\n",
];
`,
    },
    python: {
      input: jsonInput,
      code: `import json
import sys

obj = json.load(sys.stdin)
for key, value in obj.items():
    print(f"{key} = {value}")
`,
    },
    ruby: {
      input: jsonInput,
      code: `require "json"

obj = JSON.parse($stdin.read)
obj.each do |key, value|
  puts "#{key} = #{value}"
end
`,
    },
    scheme: {
      input: jsonInput,
      code: `; Parses the Input tab with the browser's JSON.parse (via js interop),
; then walks the object's keys and values as an alist.
(define (read-all)
  (let loop ((acc ""))
    (let ((line (read-line)))
      (if (eof-object? line)
          acc
          (loop (string-append acc line))))))

(define obj (js-invoke (js-eval "JSON") "parse" (read-all)))

(for-each
  (lambda (pair)
    (display (string-append (car pair) " = " (js-call (js-eval "String") (cdr pair))))
    (newline))
  (js-obj->alist obj))
`,
    },
    clojure: {
      input: jsonInput,
      code: `; Parses the Input tab with the browser's JSON.parse (via js interop),
; then walks the resulting map.
(def obj
  (js->clj (js/JSON.parse (apply str (take-while some? (repeatedly read-line))))))

(doseq [[k v] obj]
  (println (str k " = " v)))
`,
    },
  };

  // Effect with traced spans (the trace tab): an Effect program whose
  // Effect.withSpan spans — concurrent fibers and a recovered failure
  // included — render as a span waterfall, via the URL-imported effect
  // library and the pbin/effect-tracing bridge (code-runner.js).
  window.PbinEffectTracing = {
    typescript: "import { Effect, Tracer, Layer, Cause } from 'https://esm.sh/effect@3.12.0?bundle';\nimport { makeEffectTracing } from 'pbin/effect-tracing';\n\n// Route Effect.withSpan into the trace waterfall (pass your own Effect\n// modules so the layer composes with the copy you imported above).\nconst TracingLive = makeEffectTracing({ Tracer, Layer, Cause });\n\nconst work = (name: string, n: number) =>\n  Effect.sync(() => {\n    let s = 0;\n    for (let i = 0; i < n; i++) s += Math.sqrt(i);\n    return Math.round(s);\n  }).pipe(Effect.withSpan(name, { attributes: { n } }));\n\nconst fetchPrice = (sku: string) =>\n  Effect.gen(function* () {\n    yield* work(`lookup ${sku}`, 80_000);\n    return (yield* work(`score ${sku}`, 30_000)) % 100;\n  }).pipe(Effect.withSpan(`fetch-price ${sku}`, { attributes: { sku } }));\n\nconst program = Effect.gen(function* () {\n  yield* work('validate-order', 150_000);\n\n  // Concurrent fibers \u2014 these spans overlap on the timeline and still\n  // parent correctly, which the plain OTel shim can't do.\n  const prices = yield* Effect.all(\n    [fetchPrice('SKU-1001'), fetchPrice('SKU-1002'), fetchPrice('SKU-1003')],\n    { concurrency: 3 },\n  );\n\n  // A failure shows up as a red ERROR span with its Cause, then recovers.\n  yield* Effect.fail(new Error('inventory service unavailable')).pipe(\n    Effect.withSpan('reserve-stock'),\n    Effect.retry({ times: 1 }),\n    Effect.catchAll(() => Effect.void),\n  );\n\n  return prices.reduce((a, b) => a + b, 0);\n}).pipe(Effect.withSpan('process-order', { attributes: { customer: 'ada' } }));\n\nconsole.log('total:', await Effect.runPromise(program.pipe(Effect.provide(TracingLive))));\n",
    javascript: "import { Effect, Tracer, Layer, Cause } from 'https://esm.sh/effect@3.12.0?bundle';\nimport { makeEffectTracing } from 'pbin/effect-tracing';\n\n// Route Effect.withSpan into the trace waterfall (pass your own Effect\n// modules so the layer composes with the copy you imported above).\nconst TracingLive = makeEffectTracing({ Tracer, Layer, Cause });\n\nconst work = (name, n) =>\n  Effect.sync(() => {\n    let s = 0;\n    for (let i = 0; i < n; i++) s += Math.sqrt(i);\n    return Math.round(s);\n  }).pipe(Effect.withSpan(name, { attributes: { n } }));\n\nconst fetchPrice = (sku) =>\n  Effect.gen(function* () {\n    yield* work(`lookup ${sku}`, 80_000);\n    return (yield* work(`score ${sku}`, 30_000)) % 100;\n  }).pipe(Effect.withSpan(`fetch-price ${sku}`, { attributes: { sku } }));\n\nconst program = Effect.gen(function* () {\n  yield* work('validate-order', 150_000);\n\n  // Concurrent fibers \u2014 these spans overlap on the timeline and still\n  // parent correctly, which the plain OTel shim can't do.\n  const prices = yield* Effect.all(\n    [fetchPrice('SKU-1001'), fetchPrice('SKU-1002'), fetchPrice('SKU-1003')],\n    { concurrency: 3 },\n  );\n\n  // A failure shows up as a red ERROR span with its Cause, then recovers.\n  yield* Effect.fail(new Error('inventory service unavailable')).pipe(\n    Effect.withSpan('reserve-stock'),\n    Effect.retry({ times: 1 }),\n    Effect.catchAll(() => Effect.void),\n  );\n\n  return prices.reduce((a, b) => a + b, 0);\n}).pipe(Effect.withSpan('process-order', { attributes: { customer: 'ada' } }));\n\nconsole.log('total:', await Effect.runPromise(program.pipe(Effect.provide(TracingLive))));\n",
  };
})();
