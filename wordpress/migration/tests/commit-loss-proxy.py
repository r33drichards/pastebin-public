#!/usr/bin/env python3
"""Hosted disposable fixture only. Drop one genuine COMMIT OK, never log packets.

This is not a general MySQL proxy: no TLS/compression changes, packet logging,
credential arguments, remote destinations or arbitrary SQL injection. Payloads
remain in bounded memory and pass unchanged except the one omitted server OK.
"""
import os
import re
import select
import socket
import sys
import threading
import time
from pathlib import Path

MAX_PACKET = 1024 * 1024


def packet_payload(frame):
    if len(frame) < 4 or len(frame) != int.from_bytes(frame[:3], 'little') + 4:
        raise ValueError('invalid packet frame')
    if len(frame) > MAX_PACKET + 4:
        raise ValueError('packet bound exceeded')
    return frame[4:]


def is_commit(frame):
    payload = packet_payload(frame)
    return frame[3] == 0 and payload[:1] == b'\x03' and payload[1:].strip().upper() == b'COMMIT'


def is_ok(frame):
    payload = packet_payload(frame)
    # A protocol-4.1 OK includes header, affected rows, insert ID, status/warnings.
    return frame[3] == 1 and len(payload) >= 7 and payload[0] == 0


def reject_encrypted_or_compressed(frame):
    payload = packet_payload(frame)
    if frame[3] == 1 and len(payload) >= 4:
        flags = int.from_bytes(payload[:4], 'little')
        if flags & (0x0800 | 0x0020):
            raise ValueError('TLS or compression requested; fixture refuses rather than changing settings')


def exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def receive(sock):
    header = exact(sock, 4)
    length = int.from_bytes(header[:3], 'little')
    if length > MAX_PACKET:
        raise ValueError('packet bound exceeded')
    return header + exact(sock, length)


def fixture_target():
    root = Path(os.environ.get('PBIN_WP_FIXTURE', ''))
    load = Path(os.environ.get('PBIN_WORDPRESS_LOAD', ''))
    if os.environ.get('PBIN_TEST_ALLOW_DATABASE_MUTATION') != '1' or not root.is_dir() or root.resolve() != root or not root.name.startswith('pbin-wp-ci.'):
        raise ValueError('disposable fixture required')
    if load != root / 'site/wp-load.php' or not load.is_file() or load.resolve() != load:
        raise ValueError('canonical fixture WordPress required')
    if re.fullmatch(r'pbin_ci_[a-f0-9]{24}', os.environ.get('PBIN_TEST_DB_NAME', '')) is None:
        raise ValueError('random disposable database required')
    host = os.environ.get('PBIN_TEST_DB_HOST', '')
    port = int(os.environ.get('PBIN_TEST_DB_PORT', '0'))
    if host not in ('127.0.0.1', 'localhost') or not 1023 < port < 65536:
        raise ValueError('loopback database required')
    return ('127.0.0.1', port)


def main():
    target = fixture_target()
    lock = threading.Lock()
    state = {'dropped': 0, 'connections': 0, 'error': False}
    sockets = []
    workers = []
    stop = threading.Event()

    def emit(value):
        with lock:
            print(value, flush=True)

    def close_pair(pair):
        for sock in pair:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    def connection(client):
        try:
            server = socket.create_connection(target, timeout=10)
        except Exception:
            with lock:
                state['error'] = True
            client.close()
            emit('PROXY_REFUSED')
            stop.set()
            return
        client.settimeout(20)
        server.settimeout(20)
        pair = (client, server)
        with lock:
            sockets.extend(pair)
            state['connections'] += 1
        context = {'pending': False}

        def relay(source, destination, from_client):
            first_client = True
            try:
                while not stop.is_set():
                    frame = receive(source)
                    if from_client:
                        if first_client:
                            reject_encrypted_or_compressed(frame)
                            first_client = False
                        if is_commit(frame):
                            with lock:
                                context['pending'] = state['dropped'] == 0
                    else:
                        with lock:
                            pending = context['pending']
                        if pending:
                            if not is_ok(frame):
                                raise ValueError('COMMIT did not receive a genuine server OK')
                            # The server has acknowledged the actual commit. Do
                            # not forward a single byte of that response.
                            with lock:
                                state['dropped'] += 1
                                context['pending'] = False
                            emit('COMMIT_OK_DROPPED')
                            close_pair(pair)
                            return
                    destination.sendall(frame)
            except (EOFError, OSError):
                pass  # Client closure, intentional drop, or cleanup.
            except Exception:
                with lock:
                    state['error'] = True
                emit('PROXY_REFUSED')
                stop.set()
            finally:
                close_pair(pair)

        thread = threading.Thread(target=relay, args=(client, server, True), daemon=True)
        thread.start()
        relay(server, client, False)
        thread.join(timeout=1)

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(4)
    emit('READY ' + str(listener.getsockname()[1]))
    deadline = time.monotonic() + 60
    try:
        while not stop.is_set() and time.monotonic() < deadline:
            ready, _, _ = select.select([listener, sys.stdin], [], [], .2)
            if sys.stdin in ready:
                if sys.stdin.readline(32) != 'stop\n':
                    raise ValueError('invalid control command')
                break
            if listener in ready:
                with lock:
                    if len(workers) >= 4:
                        raise ValueError('connection bound exceeded')
                client, address = listener.accept()
                if address[0] != '127.0.0.1':
                    client.close()
                    raise ValueError('nonloopback client')
                thread = threading.Thread(target=connection, args=(client,), daemon=True)
                thread.start()
                workers.append(thread)
        else:
            raise ValueError('proxy deadline or refusal')
    finally:
        stop.set()
        listener.close()
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        for thread in workers:
            thread.join(timeout=2)
    if state['error'] or state['dropped'] != 1 or state['connections'] < 2:
        raise ValueError('required commit drop and actual reconnect not established')
    emit('COMPLETE')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No packet, database/user name, credentials or exception detail logged.
        print('PROXY_REFUSED', flush=True)
        sys.exit(1)
