export const API = {
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  spi: 'https://api.bilibili.com/x/frontend/finger/spi',
  opusFeed: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/feed/space',
  opusDetail: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail',
  dynamicDetail: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail',
  articleView: 'https://api.bilibili.com/x/article/view',
  /** 稿件详情（aid → bvid / 封面 pic）。附榜的封面解析用，不需要 WBI 签名 */
  videoView: 'https://api.bilibili.com/x/web-interface/view'
};

export const WEB = {
  readPage: (cv) => 'https://www.bilibili.com/read/cv' + cv + '/',
  space: (mid) => 'https://space.bilibili.com/' + mid,
  readList: (id) => 'https://www.bilibili.com/read/readlist/rl' + id
};

export function feedParams(mid, offset) {
  return { host_mid: mid, offset: offset || '', page: 1, timezone_offset: -480 };
}

export function detailParams(id) {
  return { id: String(id), timezone_offset: -480 };
}
