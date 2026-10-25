<?php
/** Long-lived socket adapter. Run only against the matching isolated WP install. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$autoload = getenv('PBIN_COMPOSER_AUTOLOAD') ?: __DIR__ . '/vendor/autoload.php';
$wpLoad = getenv('PBIN_WORDPRESS_LOAD');
if (!$wpLoad || !is_file($wpLoad)) { throw new RuntimeException('PBIN_WORDPRESS_LOAD must name wp-load.php'); }
require $autoload;
$_SERVER['REQUEST_URI'] = '/__pbin_companion_bootstrap__';
$_SERVER['HTTP_HOST'] = 'localhost';
require $wpLoad;
require_once __DIR__ . '/../pbin/includes/ot.php';
require_once __DIR__ . '/../pbin/includes/collab-store.php';

use Workerman\Worker;
use Workerman\Timer;
use Workerman\Connection\TcpConnection;
use Workerman\Protocols\Http\Request;

$origins = array_filter(array_map('trim', explode(',', getenv('PBIN_ALLOWED_ORIGINS') ?: '')));
if (!$origins) { throw new RuntimeException('Set explicit PBIN_ALLOWED_ORIGINS before starting'); }
$listener = getenv('PBIN_COLLAB_LISTEN') ?: 'websocket://127.0.0.1:8825';
$worker = new Worker($listener);
$worker->name = 'pbin-collab';
$worker->count = 1; // A single fanout process; multiworker requires shared pub/sub.
TcpConnection::$defaultMaxPackageSize = 8 << 20;
TcpConnection::$defaultMaxSendBufferSize = 8 << 20;
Worker::$logFile = getenv('PBIN_COLLAB_LOG') ?: sys_get_temp_dir() . '/pbin-collab.log';
Worker::$pidFile = getenv('PBIN_COLLAB_PID') ?: sys_get_temp_dir() . '/pbin-collab.pid';

$rooms = [];
$store = null;
$send = static function ($connection, array $message): void {
    $connection->send(json_encode($message, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE));
};
$broadcast = static function (string $id, array $message, ?int $except = null) use (&$rooms, $send): void {
    foreach (($rooms[$id]['clients'] ?? []) as $cid => $c) {
        if ($cid !== $except) { $send($c, $message); }
    }
};
// The store supplies committed events only; no in-memory save can overwrite PUT.
$sync = static function (string $id, $sender = null, ?int $ackRev = null) use (&$rooms, &$store, $broadcast, $send): void {
    if (!isset($rooms[$id])) { return; }
    $result = $store->changesSince($id, $rooms[$id]['rev']);
    foreach ($result['changes'] as $event) {
        $op = PBIN_TextOp::fromWire($event['op']);
        foreach ($rooms[$id]['clients'] as $other) {
            if (isset($other->pbinPeer['sel'])) {
                $other->pbinPeer['sel']['anchor'] = $op->TransformIndex($other->pbinPeer['sel']['anchor']);
                $other->pbinPeer['sel']['head'] = $op->TransformIndex($other->pbinPeer['sel']['head']);
            }
        }
        if ($sender && $event['rev'] === $ackRev) {
            $send($sender, ['type'=>'ack','rev'=>$event['rev']]);
            $broadcast($id, ['type'=>'op','rev'=>$event['rev'],'op'=>$event['op'],'clientId'=>$sender->pbinPeer['id']], $sender->id);
        } else {
            $broadcast($id, ['type'=>'op','rev'=>$event['rev'],'op'=>$event['op'],'clientId'=>'']);
        }
        $rooms[$id]['rev'] = $event['rev'];
    }
    if ($result['lang'] !== $rooms[$id]['lang']) {
        $rooms[$id]['lang'] = $result['lang'];
        $broadcast($id, ['type'=>'lang','lang'=>$result['lang']]);
    }
    if ($result['changes']) { $broadcast($id, ['type'=>'saved','rev'=>$result['rev']]); }
};
$worker->onWorkerStart = static function () use (&$store, &$rooms, $sync): void {
    $store = new PBIN_CollabStore();
    Timer::add(0.1, static function () use (&$rooms, $sync): void {
        foreach (array_keys($rooms) as $id) {
            try { $sync($id); } catch (Throwable $e) {
                foreach ($rooms[$id]['clients'] ?? [] as $c) { $c->close(); }
                error_log('pbin realtime sync failed: ' . $e->getMessage());
            }
        }
    });
};
$worker->onWebSocketConnect = static function ($c, Request $request) use ($origins): void {
    if (!in_array($request->header('origin'), $origins, true) || !str_ends_with($request->path(), '/collab')) {
        $c->close("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", true);
    }
};
$worker->onWebSocketConnected = static function ($c, Request $request) use (&$rooms, &$store, $send, $broadcast, $sync): void {
    try {
        $id = (string) $request->get('id', '');
        $key = (string) $request->get('key', '');
        if (strlen($key) > 64) { $key = ''; }
        if (!$id) { throw new RuntimeException('missing id'); }
        $state = $store->load($id, $key);
        if (isset($rooms[$id])) {
            for ($attempt=0; $attempt<8; ++$attempt) {
                $sync($id); $state=$store->load($id,$key);
                if ($state['rev'] === $rooms[$id]['rev']) { break; }
            }
            if ($state['rev'] !== $rooms[$id]['rev']) { throw new RuntimeException('resync'); }
        }
        else { $rooms[$id] = ['rev' => $state['rev'], 'lang'=>$state['lang'], 'clients' => []]; }
        $name = mb_substr(trim(preg_replace('/[\x00-\x1f\x7f]/u', '', (string) $request->get('name', ''))), 0, 32);
        if ($name === '') { $name = 'Otter'; }
        $peer = ['id' => substr(bin2hex(random_bytes(8)), 0, 8), 'name' => $name, 'color' => '#0091ff'];
        $peers = array_map(static fn($other) => $other->pbinPeer, array_values($rooms[$id]['clients']));
        $c->pbinRoom = $id; $c->pbinKey = $key; $c->pbinPeer = $peer;
        $rooms[$id]['clients'][$c->id] = $c;
        $send($c, ['type'=>'init', 'rev'=>$state['rev'], 'text'=>$state['text'], 'lang'=>$state['lang'], 'peer'=>$peer, 'peers'=>$peers, 'session'=>$state['session'], 'lastSeq'=>$state['lastSeq'], 'fresh'=>!$peers && $state['rev']===0]);
        $broadcast($id, ['type'=>'join','peer'=>$peer], $c->id);
    } catch (Throwable $e) { $send($c, ['type'=>'error','error'=>$e->getMessage()]); $c->close(); }
};
$worker->onMessage = static function ($c, string $data) use (&$rooms, &$store, $send, $broadcast, $sync): void {
    try {
        if (!isset($c->pbinRoom)) { $c->close(); return; }
        $id = $c->pbinRoom;
        $message = PBIN_JSON::decode($data, true);
        if (!is_array($message)) { throw new RuntimeException('invalid message'); }
        $sync($id);
        switch ($message['type'] ?? '') {
            case 'op':
                if (!isset($message['rev'], $message['op']) || !is_int($message['rev']) || !is_array($message['op'])) { throw new RuntimeException('invalid operation'); }
                $applied = $store->apply($id, $message['rev'], (int)($message['seq'] ?? 0), $c->pbinKey, $message['op']);
                $sync($id, $c, $applied['rev']);
                break;
            case 'lang':
                if (!is_string($message['lang'] ?? null) || strlen($message['lang']) > 64) { break; }
                $store->setLanguage($id, $message['lang']);
                $sync($id);
                break;
            case 'cursor':
                $state = $store->load($id); $len = strlen(PBIN_UTF16::fromUTF8($state['text'])) / 2;
                $sel = $message['sel'] ?? null;
                if ($sel !== null) { $sel = ['anchor'=>max(0,min($len,(int)($sel['anchor']??0))), 'head'=>max(0,min($len,(int)($sel['head']??0)))]; }
                $c->pbinPeer['sel'] = $sel;
                $broadcast($id, ['type'=>'cursor','clientId'=>$c->pbinPeer['id'],'sel'=>$sel], $c->id); break;
            case 'name':
                $name = mb_substr(trim(preg_replace('/[\x00-\x1f\x7f]/u','',(string)($message['name']??''))),0,32);
                if ($name !== '') { $c->pbinPeer['name']=$name; $broadcast($id,['type'=>'join','peer'=>$c->pbinPeer],$c->id); } break;
            case 'ping': break;
        }
    } catch (Throwable $e) { $send($c, ['type'=>'error','error'=>$e->getMessage()]); $c->close(); }
};
$worker->onClose = static function ($c) use (&$rooms, $broadcast): void {
    if (!isset($c->pbinRoom)) { return; }
    $id=$c->pbinRoom; unset($rooms[$id]['clients'][$c->id]);
    $broadcast($id,['type'=>'leave','clientId'=>$c->pbinPeer['id']]);
    if (empty($rooms[$id]['clients'])) { unset($rooms[$id]); }
};
$worker->onBufferFull = static function ($c): void { $c->close(); };
Worker::runAll();
