<?php
namespace Pbin\Plugin;
use RuntimeException;
use DOMDocument;
use PbinVendor;
defined('ABSPATH') || exit;
require_once Instance::current()->pluginDir . '/vendor/Parsedown.php';
require_once Instance::current()->pluginDir . '/vendor/ParsedownExtra.php';
require_once Instance::current()->pluginDir . '/vendor/Spyc.php';

final class PBIN_Markdown {
    public static function render(string $markdown): string {
        $title = '';
        // Match the reference's line-oriented front matter delimiter. Metadata
        // is data only; the YAML parser cannot instantiate PHP objects.
        if (str_starts_with($markdown, '---') && str_contains($markdown, "\n")) {
            $lines = explode("\n", $markdown); $end = null;
            for ($i = 1; $i < count($lines); ++$i) {
                if (str_starts_with($lines[$i], '---') && $i < count($lines) - 1) { $end = $i; break; }
            }
            if ($end === null) { throw new RuntimeException('unterminated YAML front matter'); }
            $metadata = PbinVendor\Spyc::YAMLLoadString(implode("\n", array_slice($lines, 1, $end - 1)));
            if (isset($metadata['title'])) {
                if (!is_scalar($metadata['title'])) { throw new RuntimeException('front matter title must be a string'); }
                $title = (string) $metadata['title'];
            }
            $markdown = implode("\n", array_slice($lines, $end + 1));
        }
        $parser = new PbinVendor\ParsedownExtra();
        $rendered = $parser->text($markdown);
        // Remove executable elements including their contents. wp_kses alone
        // removes their tags but would leave script text visible in the page.
        $dom = new DOMDocument('1.0', 'UTF-8');
        $previous = libxml_use_internal_errors(true);
        $dom->loadHTML('<?xml encoding="UTF-8"><html><body>' . $rendered . '</body></html>', LIBXML_NONET);
        libxml_clear_errors(); libxml_use_internal_errors($previous);
        foreach (['script', 'style', 'iframe', 'object', 'embed', 'applet', 'template'] as $tag) {
            foreach (iterator_to_array($dom->getElementsByTagName($tag)) as $node) { $node->parentNode->removeChild($node); }
        }
        foreach ($dom->getElementsByTagName('a') as $link) { $link->setAttribute('target', '_blank'); $link->setAttribute('rel', 'nofollow noopener noreferrer'); }
        foreach (range(1, 6) as $level) {
            foreach ($dom->getElementsByTagName('h' . $level) as $heading) {
                if (!$heading->hasAttribute('id')) {
                    $heading->setAttribute('id', strtolower(trim(preg_replace('/[^\pL\pN]+/u', '-', $heading->textContent), '-')));
                }
            }
        }
        $body = $dom->getElementsByTagName('body')->item(0); $html = '';
        if ($body) { foreach ($body->childNodes as $child) { $html .= $dom->saveHTML($child); } }
        $allowed = wp_kses_allowed_html('post');
        $allowed['input'] = ['type' => true, 'disabled' => true, 'checked' => true];
        $allowed['del'] = [];
        $allowed['th']['align'] = true; $allowed['td']['align'] = true;
        $html = wp_kses($html, $allowed, ['http', 'https', 'mailto', 'ftp']);
        return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' . pbin_html($title) . '</title><style>' . file_get_contents(Instance::current()->pluginDir . '/static/css/markdown.css') . '</style></head><body class="markdown-body">' . $html . '</body></html>';
    }
}
