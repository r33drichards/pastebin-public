# Vendored parsers

These MIT-licensed upstream releases are included so ordinary WordPress plugin
installation does not need Composer or runtime downloads:

- Parsedown 1.7.4: https://github.com/erusev/parsedown/tree/1.7.4
- Parsedown Extra 0.8.1: https://github.com/erusev/parsedown-extra/tree/0.8.1
- Spyc 0.6.3: https://github.com/mustangostang/spyc/tree/0.6.3

The associated license files are retained. Local compatibility patches: three
nullable `array $Block = null` parameters in Parsedown/ParsedownExtra are declared
`?array` for PHP 8.4. Classes/functions are isolated in the `PbinVendor` namespace
(with imports for PHP's DOM/Exception/stdClass types and corresponding Spyc
existence checks) to avoid collisions with other installed WordPress plugins.
The Extra HTML parser uses `mb_encode_numericentity` instead of PHP 8.2's deprecated
HTML-ENTITIES conversion mode. It still requires the mbstring and DOM extensions.
No other vendor source modifications are intended.

Markdown output is not trusted. The controller removes executable element
subtrees and applies WordPress's `wp_kses` allowlist before rendering. The YAML
parser only reads metadata; it does not load objects or run tags as code.
