import { createHash } from 'node:crypto';

// 中文摘要与采集原文全文绑定；原帖变化时回退原文，避免沿用过期结论。
const COPIES = {
  "2107158998495748264": {
    "hash": "d2366060b858c9da9ab8b633924951f05cbcf30a208a3132af23e3436d8f469d",
    "title": "默认速度提升约 50%",
    "kind": "update"
  },
  "2107368734981517634": {
    "hash": "4d34e417ba74a0f768afd97476dc55bd20e4d9763ba5cd5a11d5523262dc9501",
    "title": "Auto-review 免费，不再消耗套餐额度",
    "kind": "update"
  },
  "2107548725359104441": {
    "hash": "b51374baf946def42ea52400f36bffd07bea0df75a1a53720836152a8dcf8066",
    "title": "简化 API 开发流程",
    "kind": "update"
  },
  "2107573405553938664": {
    "hash": "5c8690ec739d5738d5b795b26992b831f7802efda257af4ece5f9f57d43d42fc",
    "title": "会议笔记可带入 Codex 上下文",
    "kind": "update"
  },
  "2107574912349303197": {
    "hash": "3f32c45b08f4e86fd84376d3220576bef09d7a723809bbb754c95f435bf1d480",
    "title": "Decisions API 上线",
    "kind": "update"
  },
  "2107575657014468879": {
    "hash": "7c20bf3e9cc58bd13ef94817d7ca5f1d197bd04af2f231178d86323ee18dbe9e",
    "title": "当天四项更新汇总",
    "kind": "roundup"
  },
  "2107913674593644711": {
    "hash": "932f22cac15aaf96dab01b94de0628fe6de89f21c87e1c29ab20a9aac20dfa71",
    "title": "GPT-6 进入 Chat，并发放储备重置",
    "kind": "update"
  },
  "2108084615349170480": {
    "hash": "de79a0b4f93783a93c724084336ef84e4417497366cdb3f4f17a2219a8095295",
    "title": "重新发布 Codex Cloud",
    "kind": "update"
  },
  "2108275041276420573": {
    "hash": "6dbb9e379052ec2cbe4506e08249f567c817b7b22855734a4bc27e0394569809",
    "title": "即时调整任务方向，推出 Sol ultrafast",
    "kind": "update"
  },
  "2108645667451318747": {
    "hash": "8c185b05860bf38e4e0c8dcaf592d24ce5110c84a7cd6a871fb94d9779428d1b",
    "title": "桌面端 Composer 输入预测",
    "kind": "update"
  },
  "2108646052178092403": {
    "hash": "07eaf3c38bc0029ee0c5ade75c691e7fafab57040f2c3d795690d727e9fc7131",
    "title": "手机端可创建并联系 Dot",
    "kind": "update"
  },
  "2109045220411351517": {
    "hash": "12c8da8032adfa1c00ee63642248456d90b5d41a591797e98f98b5ab23dad84c",
    "title": "完整额度重置",
    "kind": "note"
  },
  "2109430343346581527": {
    "hash": "f5fd7a1ccd454399a36efd08cff071fe7c220fafd696dd72e471a89acc3d5caa",
    "title": "Sol 默认上下文增至 500k",
    "kind": "update"
  },
  "2109812216212099456": {
    "hash": "8164749d90ecd96301d2918bf1737d0c70308d4822448565319da533cae9775b",
    "title": "完整额度重置",
    "kind": "note"
  },
  "2110151780478927344": {
    "hash": "964b65e178e6659f40870fad1f7224deb6b43ddcad575024191c12974881fdfe",
    "title": "桌面端磁盘占用减少约 60%",
    "kind": "update"
  },
  "2110595484180214059": {
    "hash": "38991b615fa396dadb7087bc50f9a45bd2a64072ca1ee7a9c8854e210317b505",
    "title": "完整额度重置",
    "kind": "note"
  },
  "2110750421367287996": {
    "hash": "4093300d3a16f144dee15c63334b12774e647e1f3f3d17c1691314c77f04f033",
    "title": "减少模型满载阻塞，支持自动继续",
    "kind": "update"
  },
  "2111244596131111253": {
    "hash": "b86e22824621324ac66a700494582cab3556eb1547699c971b3e07217817f692",
    "title": "复用上下文、延长缓存，提高有效用量",
    "kind": "update"
  },
  "2111492673890824348": {
    "hash": "63add0a7447b6734fee2221c04ddfd80088c10eb65170f3f7d2054c901c28b71",
    "title": "完整额度重置",
    "kind": "note"
  },
  "2111990254408434095": {
    "hash": "b6bf62df8877b957cde7a0b08023ab47c403a521d4b5207371486827e591a9b1",
    "title": "桌面端支持编辑会话中的历史消息",
    "kind": "update"
  },
  "2112268918681485431": {
    "hash": "85baa7522bf092b3f4317fd3df0dfe0387b42abeb8d6f3c185af3c0ab81c531e",
    "title": "当天状态说明，未宣布具体交付",
    "kind": "note"
  },
  "2112432076767289678": {
    "hash": "ac73a92917eac8b5d9b1f0371b7a33e1eb326f4caff59884576bc52f39b8c932",
    "title": "额度重置已发放",
    "kind": "note"
  },
  "2112712984644784534": {
    "hash": "12f45079f76d50b5c1ce6e27105bff8159b970e3cd74e9f2bcb8c49deb062858",
    "title": "API 缓存延长至 12 小时，优化旧会话缓存命中",
    "kind": "update"
  }
};

export function programPostCopy(tweet) {
  const text = String(tweet?.text ?? '');
  const copy = COPIES[String(tweet?.id)];
  if (copy && createHash('sha256').update(text).digest('hex') === copy.hash) {
    return { title: copy.title, kind: copy.kind };
  }
  const body = text.replace(/\bDay\s*\d+(?:\.\d+|\s*\([^)]*\))?\s*\//i, '').replace(/https?:\/\/\S+/g, '').trim();
  return { title: body.length > 90 ? body.slice(0, 90) + '…' : body || '当日动态', kind: 'note' };
}

// 已逐组核对的活动跟进帖；只补展示归属，到账仍须有现存确认记录。
const FOLLOWUPS = {
  "2107676072871600470": {
    "anchorId": "2107575657014468879",
    "day": 2,
    "title": "四项更新后，追加额度重置",
    "hash": "e18e1588338564c98bcf0e60e5b53f881a89973a3fb61670d38b85fbdf0e233c",
    "anchorHash": "7c20bf3e9cc58bd13ef94817d7ca5f1d197bd04af2f231178d86323ee18dbe9e"
  },
  "2108040921044639779": {
    "anchorId": "2107913674593644711",
    "day": 3,
    "title": "确认储备重置已到账",
    "hash": "505e7065a9b083dbd9631555ca4e1ac21cbbc6ee5d0f4be6055d2dbb1d2f6834",
    "anchorHash": "932f22cac15aaf96dab01b94de0628fe6de89f21c87e1c29ab20a9aac20dfa71"
  },
  "2109132167112782291": {
    "anchorId": "2109045220411351517",
    "day": 6,
    "title": "确认额度重置已全部到账",
    "hash": "c7417b6db3a17a6c664d7e74459ff83f0408b99ab4465b447e5ccd4322b371e8",
    "anchorHash": "12c8da8032adfa1c00ee63642248456d90b5d41a591797e98f98b5ab23dad84c"
  },
  "2109873287853707513": {
    "anchorId": "2109812216212099456",
    "day": 8,
    "title": "确认额度重置已完成",
    "hash": "82b53c9e0c904ebf9ddf09088644e5743328452390a783406a1d09e403c0ff50",
    "anchorHash": "8164749d90ecd96301d2918bf1737d0c70308d4822448565319da533cae9775b"
  },
  "2110618732666257557": {
    "anchorId": "2110595484180214059",
    "day": 10,
    "title": "确认额度重置已完成",
    "hash": "0aed7f04ca2e2c0457d36d78dcfcb1cc16eb888845e87c9c2fc25227356b65ee",
    "anchorHash": "38991b615fa396dadb7087bc50f9a45bd2a64072ca1ee7a9c8854e210317b505"
  },
  "2111566005684289735": {
    "anchorId": "2111492673890824348",
    "day": 13,
    "title": "后续确认额度重置已完成",
    "hash": "11a6767d5674c7e45f7e00dc525762275b3a48491ad6045427d2609cc496c516",
    "anchorHash": "63add0a7447b6734fee2221c04ddfd80088c10eb65170f3f7d2054c901c28b71"
  }
};

export function programFollowup(tweet, tweets) {
  const link = FOLLOWUPS[String(tweet?.id)];
  if (!link || createHash('sha256').update(String(tweet?.text ?? '')).digest('hex') !== link.hash) return null;
  const anchor = tweets.find((item) => String(item.id) === link.anchorId);
  if (!anchor || createHash('sha256').update(String(anchor.text ?? '')).digest('hex') !== link.anchorHash) return null;
  const age = Date.parse(tweet.created_at) - Date.parse(anchor.created_at);
  if (!Number.isFinite(age) || age <= 0 || age > 86_400_000) return null;
  return { day: link.day, title: link.title, anchorId: link.anchorId };
}
