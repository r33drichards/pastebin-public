// Language-aware completions for the room editor.
//
// Monaco only ships real language services (type-aware completions, hovers,
// diagnostics) for TypeScript/JavaScript, CSS/SCSS/LESS, HTML and JSON; those
// run in web workers. Everything else gets syntax highlighting but no
// suggestions beyond words already in the document. This module closes that
// gap for the whole language picker:
//
//  1. MonacoEnvironment below lets the built-in language-service workers
//     start even though the editor is loaded from a CDN (cross-origin
//     workers are blocked, so Monaco would otherwise fall back to running
//     the services on the main thread).
//  2. For every other language it registers a completion provider that
//     suggests the language's keywords, builtins, types and constants. The
//     word lists come from Monaco's own Monarch grammars — loaded on demand
//     from vs/basic-languages/<lang> for the ~70 bundled languages, and
//     captured via captureMonarch() for the grammars this site defines
//     itself (jsx, minizinc, tlaplus, picat, ocaml).
//  3. Curated snippets (SNIPPETS) add common constructs for popular
//     languages on top of the word lists.
//
// Suggestions appear as you type (Monaco's quickSuggestions default) or on
// Ctrl+Space, and compose with the document-word suggestions and the AI
// ghost text from fim-completion.js.
(function (global) {
  'use strict';

  var MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/';

  // Let Monaco start its language-service workers from the CDN. A same-origin
  // data: URL bootstraps the cross-origin worker script; without this the
  // worker constructor throws and Monaco degrades to the main thread.
  if (!global.MonacoEnvironment) {
    global.MonacoEnvironment = {
      getWorkerUrl: function () {
        return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
          "self.MonacoEnvironment = { baseUrl: '" + MONACO_BASE + "' };" +
          "importScripts('" + MONACO_BASE + "vs/base/worker/workerMain.js');"
        );
      }
    };
  }

  // Languages whose completions come from Monaco's own language services;
  // adding keyword lists there would only duplicate what the worker returns.
  var HAS_LANGUAGE_SERVICE = {
    javascript: true, typescript: true, json: true,
    css: true, scss: true, less: true,
    html: true, handlebars: true, razor: true
  };

  // The cpp grammar registers both ids from one module; everything else in
  // vs/basic-languages lives in a directory named after its language id.
  var BASIC_MODULE = { c: 'cpp' };

  // Monarch grammars registered by the page itself (captureMonarch below).
  var capturedGrammars = {};

  // Word-list properties worth suggesting. Monarch grammars have no fixed
  // schema, so match by name and skip the punctuation-style lists.
  var LIST_KEY = /keyword|builtin|predefined|constant|support|module|type|intrinsic|register|verb|variable/i;
  var SKIP_KEY = /^(operators|symbols|brackets|escapes|tokenizer|tokenPostfix|defaultToken|ignoreCase|unicode|includeLF|start)$/;
  var WORD = /^[A-Za-z_$][A-Za-z0-9_$'!?.\-]*$/;

  function kindForKey(key, kinds) {
    var k = key.toLowerCase();
    if (k.indexOf('variable') >= 0) return kinds.Variable;
    if (k.indexOf('function') >= 0 || k.indexOf('builtin') >= 0 ||
        k.indexOf('predefined') >= 0 || k.indexOf('support') >= 0 ||
        k.indexOf('intrinsic') >= 0 || k.indexOf('verb') >= 0) return kinds.Function;
    if (k.indexOf('type') >= 0) return kinds.Class;
    if (k.indexOf('constant') >= 0) return kinds.Constant;
    if (k.indexOf('module') >= 0 || k.indexOf('register') >= 0) return kinds.Module;
    return kinds.Keyword;
  }

  // Pulls suggestable words out of a Monarch grammar definition.
  function wordsFromGrammar(monaco, grammar) {
    var kinds = monaco.languages.CompletionItemKind;
    var out = [];
    var seen = {};
    Object.keys(grammar || {}).forEach(function (key) {
      var list = grammar[key];
      if (!Array.isArray(list) || SKIP_KEY.test(key) || !LIST_KEY.test(key)) return;
      var kind = kindForKey(key, kinds);
      list.forEach(function (word) {
        if (typeof word !== 'string' || word.length < 2 || !WORD.test(word)) return;
        if (seen[word]) return;
        seen[word] = true;
        out.push({ label: word, kind: kind, insertText: word, detail: key });
      });
    });
    return out;
  }

  // Loads the Monarch grammar Monaco bundles for a language, if any.
  function loadBasicGrammar(langId) {
    return new Promise(function (resolve) {
      var dir = BASIC_MODULE[langId] || langId;
      try {
        global.require(
          ['vs/basic-languages/' + dir + '/' + dir],
          function (mod) { resolve(mod && mod.language ? mod.language : null); },
          function () { resolve(null); }
        );
      } catch (e) {
        resolve(null);
      }
    });
  }

  function snippetEntries(monaco, langId) {
    var kinds = monaco.languages.CompletionItemKind;
    var rules = monaco.languages.CompletionItemInsertTextRule;
    return (SNIPPETS[langId] || []).map(function (s) {
      return {
        label: s[0],
        kind: kinds.Snippet,
        insertText: s[2],
        insertTextRules: rules.InsertAsSnippet,
        detail: s[1],
        // Surface snippets above the plain word lists.
        sortText: '0' + s[0]
      };
    });
  }

  var entryCache = {};

  // Languages a real language server has taken over (e.g. basedpyright):
  // their keyword/builtin word lists become noise, but snippets stay useful.
  var claimed = {};

  function entriesFor(monaco, langId) {
    if (!entryCache[langId]) {
      entryCache[langId] = (capturedGrammars[langId]
        ? Promise.resolve(capturedGrammars[langId])
        : loadBasicGrammar(langId)
      ).then(function (grammar) {
        var entries = snippetEntries(monaco, langId);
        var words = grammar ? wordsFromGrammar(monaco, grammar) : [];
        (EXTRA_WORDS[langId] || []).forEach(function (word) {
          words.push({
            label: word,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: word
          });
        });
        var seen = {};
        entries.forEach(function (e) { seen[e.label] = true; });
        words.forEach(function (w) {
          if (!seen[w.label]) { seen[w.label] = true; entries.push(w); }
        });
        return entries;
      });
    }
    return entryCache[langId];
  }

  function registerProvider(monaco, langId) {
    monaco.languages.registerCompletionItemProvider(langId, {
      provideCompletionItems: function (model, position) {
        return entriesFor(monaco, langId).then(function (entries) {
          if (claimed[langId]) {
            entries = entries.filter(function (e) {
              return e.kind === monaco.languages.CompletionItemKind.Snippet;
            });
          }
          if (!entries.length) return { suggestions: [] };
          var word = model.getWordUntilPosition(position);
          var range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };
          return {
            suggestions: entries.map(function (e) {
              var item = Object.assign({ range: range }, e);
              return item;
            })
          };
        });
      }
    });
  }

  // Wraps setMonarchTokensProvider so grammars the page registers afterwards
  // (jsx, minizinc, tlaplus, picat, ocaml) feed the completion providers too.
  function captureMonarch(monaco) {
    var original = monaco.languages.setMonarchTokensProvider;
    monaco.languages.setMonarchTokensProvider = function (langId, grammar) {
      if (grammar && typeof grammar.then !== 'function') {
        capturedGrammars[langId] = grammar;
      }
      return original.call(monaco.languages, langId, grammar);
    };
  }

  // Registers a completion provider for every language in the picker. Call
  // after all custom languages are registered, before or after editor
  // creation — providers resolve their word lists lazily.
  function init(monaco) {
    var ids = {};
    monaco.languages.getLanguages().forEach(function (l) { ids[l.id] = true; });
    Object.keys(capturedGrammars).forEach(function (id) { ids[id] = true; });
    // Languages with snippets or word lists but no registered grammar
    // (mermaid) still need a language id for the provider to match.
    Object.keys(SNIPPETS).concat(Object.keys(EXTRA_WORDS)).forEach(function (id) {
      if (!ids[id]) {
        monaco.languages.register({ id: id });
        ids[id] = true;
      }
    });
    Object.keys(ids).forEach(function (id) {
      if (HAS_LANGUAGE_SERVICE[id] || id === 'plaintext') return;
      registerProvider(monaco, id);
    });
  }

  // Word lists for languages without a Monarch grammar to harvest.
  var EXTRA_WORDS = {
    mermaid: [
      'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2',
      'erDiagram', 'gantt', 'pie', 'journey', 'mindmap', 'timeline', 'gitGraph',
      'subgraph', 'end', 'participant', 'actor', 'activate', 'deactivate',
      'note', 'loop', 'alt', 'else', 'opt', 'par', 'critical', 'break',
      'title', 'section', 'direction', 'classDef', 'class', 'click', 'style',
      'linkStyle', 'accTitle', 'accDescr', 'autonumber'
    ]
  };

  // [label, description, snippet] per language. Tab stops use ${n:placeholder}.
  var SNIPPETS = {
    python: [
      ['def', 'function definition', 'def ${1:name}(${2:args}):\n\t${0:pass}'],
      ['class', 'class definition', 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0:pass}'],
      ['ifmain', 'main guard', 'if __name__ == "__main__":\n\t${0:main()}'],
      ['for', 'for loop', 'for ${1:item} in ${2:items}:\n\t${0:pass}'],
      ['while', 'while loop', 'while ${1:condition}:\n\t${0:pass}'],
      ['try', 'try/except', 'try:\n\t${1:pass}\nexcept ${2:Exception} as e:\n\t${0:raise}'],
      ['with', 'with open', 'with open(${1:path}) as ${2:f}:\n\t${0:pass}'],
      ['lambda', 'lambda', 'lambda ${1:x}: ${0:x}']
    ],
    go: [
      ['main', 'main package', 'package main\n\nimport "fmt"\n\nfunc main() {\n\t${0:fmt.Println("hello")}\n}'],
      ['func', 'function', 'func ${1:name}(${2}) ${3:error} {\n\t${0}\n}'],
      ['iferr', 'if err != nil', 'if err != nil {\n\t${0:return err}\n}'],
      ['for', 'for loop', 'for ${1:i} := 0; $1 < ${2:n}; $1++ {\n\t${0}\n}'],
      ['forr', 'for range', 'for ${1:_}, ${2:v} := range ${3:items} {\n\t${0}\n}'],
      ['struct', 'struct type', 'type ${1:Name} struct {\n\t${0}\n}'],
      ['method', 'method', 'func (${1:r} ${2:*Type}) ${3:Name}(${4}) ${5:error} {\n\t${0}\n}']
    ],
    rust: [
      ['fn', 'function', 'fn ${1:name}(${2}) ${3}{\n\t${0}\n}'],
      ['main', 'main function', 'fn main() {\n\t${0:println!("hello");}\n}'],
      ['struct', 'struct', 'struct ${1:Name} {\n\t${0}\n}'],
      ['impl', 'impl block', 'impl ${1:Name} {\n\t${0}\n}'],
      ['match', 'match expression', 'match ${1:value} {\n\t${2:pattern} => ${3:result},\n\t_ => ${0:unreachable!()},\n}'],
      ['for', 'for loop', 'for ${1:item} in ${2:items} {\n\t${0}\n}'],
      ['derive', 'derive attribute', '#[derive(${1:Debug, Clone})]']
    ],
    cpp: [
      ['main', 'main with iostream', '#include <iostream>\n\nint main() {\n\t${0:std::cout << "hello" << std::endl;}\n\treturn 0;\n}'],
      ['inc', '#include', '#include <${1:vector}>'],
      ['for', 'for loop', 'for (${1:int} ${2:i} = 0; $2 < ${3:n}; ++$2) {\n\t${0}\n}'],
      ['forr', 'range-based for', 'for (const auto& ${1:item} : ${2:items}) {\n\t${0}\n}'],
      ['class', 'class', 'class ${1:Name} {\npublic:\n\t${0}\n};'],
      ['cout', 'print line', 'std::cout << ${1:value} << std::endl;']
    ],
    java: [
      ['main', 'class with main', 'public class ${1:Main} {\n\tpublic static void main(String[] args) {\n\t\t${0:System.out.println("hello");}\n\t}\n}'],
      ['sout', 'print line', 'System.out.println(${0});'],
      ['for', 'for loop', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t${0}\n}'],
      ['fore', 'enhanced for', 'for (${1:var} ${2:item} : ${3:items}) {\n\t${0}\n}'],
      ['method', 'method', 'public ${1:void} ${2:name}(${3}) {\n\t${0}\n}']
    ],
    csharp: [
      ['main', 'class with Main', 'class ${1:Program} {\n\tstatic void Main(string[] args) {\n\t\t${0:System.Console.WriteLine("hello");}\n\t}\n}'],
      ['cw', 'Console.WriteLine', 'Console.WriteLine(${0});'],
      ['for', 'for loop', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t${0}\n}'],
      ['foreach', 'foreach loop', 'foreach (var ${1:item} in ${2:items}) {\n\t${0}\n}'],
      ['prop', 'auto property', 'public ${1:string} ${2:Name} { get; set; }']
    ],
    ruby: [
      ['def', 'method definition', 'def ${1:name}${2}\n\t${0}\nend'],
      ['class', 'class definition', 'class ${1:Name}\n\t${0}\nend'],
      ['each', 'each block', '${1:items}.each do |${2:item}|\n\t${0}\nend'],
      ['if', 'if statement', 'if ${1:condition}\n\t${0}\nend']
    ],
    lua: [
      ['function', 'function', 'function ${1:name}(${2})\n\t${0}\nend'],
      ['local', 'local variable', 'local ${1:name} = ${0:value}'],
      ['for', 'numeric for', 'for ${1:i} = ${2:1}, ${3:n} do\n\t${0}\nend'],
      ['forp', 'for pairs', 'for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t${0}\nend'],
      ['if', 'if statement', 'if ${1:condition} then\n\t${0}\nend']
    ],
    shell: [
      ['shebang', 'bash header', '#!/usr/bin/env bash\nset -euo pipefail\n\n${0}'],
      ['for', 'for loop', 'for ${1:item} in ${2:list}; do\n\t${0}\ndone'],
      ['if', 'if statement', 'if [[ ${1:condition} ]]; then\n\t${0}\nfi'],
      ['while', 'while loop', 'while ${1:condition}; do\n\t${0}\ndone'],
      ['case', 'case statement', 'case ${1:value} in\n\t${2:pattern})\n\t\t${0}\n\t\t;;\nesac'],
      ['func', 'function', '${1:name}() {\n\t${0}\n}']
    ],
    perl: [
      ['header', 'strict header', '#!/usr/bin/env perl\nuse strict;\nuse warnings;\n\n${0}'],
      ['sub', 'subroutine', 'sub ${1:name} {\n\tmy (${2:\\$arg}) = @_;\n\t${0}\n}'],
      ['foreach', 'foreach loop', 'foreach my ${1:\\$item} (${2:@items}) {\n\t${0}\n}']
    ],
    kotlin: [
      ['main', 'main function', 'fun main() {\n\t${0:println("hello")}\n}'],
      ['fun', 'function', 'fun ${1:name}(${2})${3} {\n\t${0}\n}'],
      ['class', 'data class', 'data class ${1:Name}(${0})'],
      ['for', 'for loop', 'for (${1:item} in ${2:items}) {\n\t${0}\n}']
    ],
    swift: [
      ['func', 'function', 'func ${1:name}(${2}) ${3}{\n\t${0}\n}'],
      ['struct', 'struct', 'struct ${1:Name} {\n\t${0}\n}'],
      ['class', 'class', 'class ${1:Name} {\n\t${0}\n}'],
      ['for', 'for-in loop', 'for ${1:item} in ${2:items} {\n\t${0}\n}'],
      ['guard', 'guard let', 'guard let ${1:value} = ${2:optional} else {\n\t${0:return}\n}']
    ],
    scala: [
      ['main', 'main object', 'object ${1:Main} {\n\tdef main(args: Array[String]): Unit = {\n\t\t${0:println("hello")}\n\t}\n}'],
      ['def', 'method', 'def ${1:name}(${2}): ${3:Unit} = {\n\t${0}\n}'],
      ['caseclass', 'case class', 'case class ${1:Name}(${0})'],
      ['for', 'for comprehension', 'for (${1:item} <- ${2:items}) {\n\t${0}\n}']
    ],
    dart: [
      ['main', 'main function', 'void main() {\n\t${0:print(\'hello\');}\n}'],
      ['class', 'class', 'class ${1:Name} {\n\t${0}\n}'],
      ['for', 'for loop', 'for (var ${1:item} in ${2:items}) {\n\t${0}\n}']
    ],
    elixir: [
      ['defmodule', 'module', 'defmodule ${1:Name} do\n\t${0}\nend'],
      ['def', 'function', 'def ${1:name}(${2}) do\n\t${0}\nend'],
      ['case', 'case expression', 'case ${1:value} do\n\t${2:pattern} -> ${0:result}\nend']
    ],
    clojure: [
      ['defn', 'function', '(defn ${1:name} [${2:args}]\n\t${0})'],
      ['let', 'let binding', '(let [${1:name} ${2:value}]\n\t${0})'],
      ['map', 'map over coll', '(map ${1:f} ${0:coll})']
    ],
    ocaml: [
      ['let', 'let binding', 'let ${1:name} = ${0}'],
      ['letrec', 'recursive function', 'let rec ${1:name} ${2:args} =\n\t${0}'],
      ['match', 'match expression', 'match ${1:value} with\n| ${2:pattern} -> ${0}'],
      ['printf', 'print line', 'Printf.printf "${1:%s\\n}" ${0}']
    ],
    fsharp: [
      ['let', 'let binding', 'let ${1:name} = ${0}'],
      ['letf', 'function', 'let ${1:name} ${2:args} =\n\t${0}'],
      ['match', 'match expression', 'match ${1:value} with\n| ${2:pattern} -> ${0}']
    ],
    sql: [
      ['select', 'select query', 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${0:condition};'],
      ['insert', 'insert statement', 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${0:values});'],
      ['update', 'update statement', 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${0:condition};'],
      ['createtable', 'create table', 'CREATE TABLE ${1:name} (\n\t${2:id} ${3:INTEGER PRIMARY KEY}${0}\n);'],
      ['join', 'inner join', 'SELECT ${1:*}\nFROM ${2:a}\nJOIN ${3:b} ON ${2:a}.${4:id} = ${3:b}.${0:id};']
    ],
    r: [
      ['function', 'function', '${1:name} <- function(${2:args}) {\n\t${0}\n}'],
      ['for', 'for loop', 'for (${1:item} in ${2:items}) {\n\t${0}\n}'],
      ['if', 'if statement', 'if (${1:condition}) {\n\t${0}\n}']
    ],
    julia: [
      ['function', 'function', 'function ${1:name}(${2:args})\n\t${0}\nend'],
      ['for', 'for loop', 'for ${1:item} in ${2:items}\n\t${0}\nend'],
      ['struct', 'struct', 'struct ${1:Name}\n\t${0}\nend']
    ],
    jsx: [
      ['component', 'function component', 'function ${1:Component}(${2:props}) {\n\treturn (\n\t\t<div>${0}</div>\n\t);\n}'],
      ['useState', 'useState hook', 'const [${1:state}, set${2:State}] = React.useState(${0:null});'],
      ['useEffect', 'useEffect hook', 'React.useEffect(() => {\n\t${0}\n}, [${1}]);'],
      ['render', 'render into root', 'ReactDOM.createRoot(document.getElementById(\'root\')).render(<${0:App} />);']
    ],
    typescript: [
      ['interface', 'interface', 'interface ${1:Name} {\n\t${0}\n}'],
      ['type', 'type alias', 'type ${1:Name} = ${0};']
    ],
    markdown: [
      ['link', 'link', '[${1:text}](${0:url})'],
      ['image', 'image', '![${1:alt}](${0:url})'],
      ['code', 'code block', '```${1:language}\n${0}\n```'],
      ['table', 'table', '| ${1:Col} | ${2:Col} |\n| --- | --- |\n| ${0} |  |']
    ],
    dockerfile: [
      ['from', 'base image', 'FROM ${1:alpine}:${0:latest}'],
      ['run', 'run command', 'RUN ${0:apk add --no-cache curl}'],
      ['copy', 'copy files', 'COPY ${1:.} ${0:/app}'],
      ['entrypoint', 'entrypoint', 'ENTRYPOINT ["${0:/app/run}"]']
    ],
    graphql: [
      ['query', 'query', 'query ${1:Name} {\n\t${0}\n}'],
      ['mutation', 'mutation', 'mutation ${1:Name}(${2}) {\n\t${0}\n}'],
      ['type', 'object type', 'type ${1:Name} {\n\t${2:id}: ${0:ID!}\n}']
    ],
    minizinc: [
      ['var', 'decision variable', 'var ${1:0..9}: ${0:x};'],
      ['array', 'array of var', 'array[${1:1..n}] of var ${2:0..9}: ${0:xs};'],
      ['constraint', 'constraint', 'constraint ${0:true};'],
      ['solve', 'solve item', 'solve ${0:satisfy};'],
      ['output', 'output item', 'output ["${0:\\(x)}"];'],
      ['forall', 'forall', 'forall(${1:i} in ${2:1..n})(${0:true})']
    ],
    picat: [
      ['main', 'main predicate', 'main =>\n\t${0:println("hello")}.'],
      ['pred', 'predicate', '${1:name}(${2:Args}) =>\n\t${0:true}.'],
      ['foreach', 'foreach loop', 'foreach (${1:I} in ${2:1..N})\n\t${0:true}\nend'],
      ['solve', 'constraint solve', '${1:Vars} = [${2}],\n$1 :: ${3:1..9},\nsolve($1)']
    ],
    tlaplus: [
      ['module', 'module skeleton', '---- MODULE ${1:Name} ----\nEXTENDS ${2:Naturals}\n\nVARIABLE ${3:x}\n\nInit == ${4:x = 0}\n\nNext == ${5:x\' = x + 1}\n\nSpec == Init /\\ [][Next]_<<${3:x}>>\n====${0}'],
      ['init', 'Init action', 'Init == ${0}'],
      ['next', 'Next action', 'Next == ${0}']
    ],
    scheme: [
      ['define', 'definition', '(define (${1:name} ${2:args})\n\t${0})'],
      ['lambda', 'lambda', '(lambda (${1:args}) ${0})'],
      ['let', 'let binding', '(let ((${1:name} ${2:value}))\n\t${0})'],
      ['cond', 'cond expression', '(cond\n\t(${1:test} ${2:result})\n\t(else ${0}))']
    ],
    mermaid: [
      ['flowchart', 'flowchart', 'flowchart ${1:LR}\n\t${2:A}[${3:Start}] --> ${0:B}'],
      ['sequence', 'sequence diagram', 'sequenceDiagram\n\tparticipant ${1:A}\n\tparticipant ${2:B}\n\t${1:A}->>${2:B}: ${0:message}'],
      ['class', 'class diagram', 'classDiagram\n\tclass ${1:Name} {\n\t\t${0}\n\t}'],
      ['state', 'state diagram', 'stateDiagram-v2\n\t[*] --> ${1:State}\n\t${1:State} --> ${0:[*]}']
    ],
    yaml: [
      ['kv', 'key with nested map', '${1:key}:\n  ${2:child}: ${0:value}'],
      ['list', 'list of items', '${1:key}:\n  - ${0:item}']
    ],
    powershell: [
      ['function', 'function', 'function ${1:Name} {\n\tparam(${2})\n\t${0}\n}'],
      ['foreach', 'foreach loop', 'foreach (${1:$item} in ${2:$items}) {\n\t${0}\n}']
    ],
    solidity: [
      ['contract', 'contract', 'contract ${1:Name} {\n\t${0}\n}'],
      ['function', 'function', 'function ${1:name}(${2}) ${3:public} ${4}{\n\t${0}\n}']
    ]
  };
  // SQL dialects share the standard snippets.
  SNIPPETS.mysql = SNIPPETS.sql;
  SNIPPETS.pgsql = SNIPPETS.sql;
  SNIPPETS.redshift = SNIPPETS.sql;

  global.PbinLSP = {
    init: init,
    captureMonarch: captureMonarch,
    claim: function (langId) { claimed[langId] = true; }
  };
})(window);
