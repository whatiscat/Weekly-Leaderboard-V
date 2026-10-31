/**
 * av 号 ↔ BV 号互转（纯算法，零请求）
 *
 * 为什么需要它：附榜（ニコニコ VOCALOID SONGS TOP20）的正文里只有视频卡片的
 * aid（如 28356844），而封面接口与「在 B 站打开」用的都是 BV 号。
 * BV 号本来就是 aid 的再编码，本地算得出来 —— 不该为了这个去调一次接口。
 */
const XOR_CODE = 23442827791579n;
const AID_MASK = (1n << 51n) - 1n;
const MAX_AID = 1n << 51n;
const BASE = 58n;
const TABLE = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
/* BV 号的字形骨架：第 0-2 位固定 BV1，第 5、7 位固定 4 与 1，其余 9 位是 base58 数字 */
const TEMPLATE = ['B', 'V', '1', ' ', ' ', '4', ' ', '1', ' ', '7', ' ', ' '];

export function av2bv(aid) {
  const n = Number(aid);
  if (!Number.isInteger(n) || n <= 0) return '';
  const bytes = TEMPLATE.slice();
  let i = bytes.length - 1;
  let tmp = (MAX_AID | BigInt(n)) ^ XOR_CODE;
  while (tmp > 0n) {
    bytes[i] = TABLE[Number(tmp % BASE)];
    tmp /= BASE;
    i -= 1;
  }
  // 两次换位：编码的最后一步，逆过来就是先换回来再读数字
  [bytes[3], bytes[9]] = [bytes[9], bytes[3]];
  [bytes[4], bytes[7]] = [bytes[7], bytes[4]];
  return bytes.join('');
}

export function bv2av(bvid) {
  const chars = String(bvid || '').split('');
  if (chars.length !== 12) return 0;
  [chars[3], chars[9]] = [chars[9], chars[3]];
  [chars[4], chars[7]] = [chars[7], chars[4]];
  let tmp = 0n;
  for (let i = 3; i < chars.length; i++) {
    const idx = TABLE.indexOf(chars[i]);
    if (idx < 0) return 0;
    tmp = tmp * BASE + BigInt(idx);
  }
  const n = Number((tmp ^ XOR_CODE) & AID_MASK);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
