import crypto from 'node:crypto';

/** B 站 wbi 签名用的固定混淆表 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/** 从 nav 接口返回的 img_url / sub_url 还原 mixin key */
export function mixinKeyFromUrls(imgUrl, subUrl) {
  const img = String(imgUrl).split('/').pop().split('.')[0];
  const sub = String(subUrl).split('/').pop().split('.')[0];
  const raw = img + sub;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 生成带 w_rid / wts 的 query string */
export function signQuery(params, mixinKey, { wts = Math.round(Date.now() / 1000) } = {}) {
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return query + '&w_rid=' + wRid;
}
