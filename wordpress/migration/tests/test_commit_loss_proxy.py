"""Pure packet/guard tests; no sockets, credentials or MySQL behavior claim."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('commit_loss_proxy', pathlib.Path(__file__).with_name('commit-loss-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def frame(payload, sequence=0):
    return len(payload).to_bytes(3, 'little') + bytes([sequence]) + payload


class PacketTests(unittest.TestCase):
    def test_only_com_query_commit_is_selected(self):
        for command in (b'COMMIT', b'commit', b' COMMIT\r\n'):
            self.assertTrue(proxy.is_commit(frame(b'\x03' + command)))
        for payload in (b'\x03COMMIT AND CHAIN', b'\x03SELECT "COMMIT"', b'\x03COMMIT;SELECT 1', b'\x16COMMIT', b'\x03ROLLBACK'):
            self.assertFalse(proxy.is_commit(frame(payload)))
        self.assertFalse(proxy.is_commit(frame(b'\x03COMMIT', 1)))

    def test_requires_complete_protocol_ok(self):
        self.assertTrue(proxy.is_ok(frame(b'\0\0\0\x02\0\0\0', 1)))
        for payload in (b'', b'\0', b'\xfferror', b'\xfe\0\0\0\0\0\0', b'\x01rowset'):
            self.assertFalse(proxy.is_ok(frame(payload, 1)))
        self.assertFalse(proxy.is_ok(frame(b'\0\0\0\x02\0\0\0', 0)))

    def test_no_tls_or_compression_downgrade(self):
        for flags in (0x0800, 0x0020, 0x0820):
            packet = frame(flags.to_bytes(4, 'little') + bytes(28), 1)
            with self.assertRaises(ValueError):
                proxy.reject_encrypted_or_compressed(packet)
            self.assertEqual(packet[4:8], flags.to_bytes(4, 'little'))
        proxy.reject_encrypted_or_compressed(frame((0x8000).to_bytes(4, 'little') + bytes(28), 1))

    def test_frame_bounds(self):
        for packet in (b'', b'\x05\0\0\0abc', frame(bytes(proxy.MAX_PACKET + 1))):
            with self.assertRaises(ValueError):
                proxy.packet_payload(packet)

    def test_fragmented_reads_and_eof(self):
        class MemorySocket:
            def __init__(self, data): self.data = data
            def recv(self, size):
                result = self.data[:min(size, 2)]
                self.data = self.data[len(result):]
                return result
        packet = frame(b'\x03COMMIT')
        self.assertEqual(proxy.receive(MemorySocket(packet)), packet)
        with self.assertRaises(EOFError):
            proxy.receive(MemorySocket(packet[:-1]))


if __name__ == '__main__':
    unittest.main()
