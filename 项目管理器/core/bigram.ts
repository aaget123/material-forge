/**
 * 中文检索的应用层 bigram 方案（开发建议 D4）。
 *
 * 为什么不用 FTS5 的 trigram / unicode61 直接搜中文：
 *  - unicode61 不切中文，实测「沙漠里的打斗片段」搜「打斗」返回 0 条；
 *  - trigram 要求子串 >= 3 个 unicode 字符，且 LIKE 会退化为全表线性扫描。
 * 所以：写入时把中文串预先切成 bigram 存进独立列，查询时把关键词也切成 bigram 做短语匹配。
 * 实测同一句搜「打斗」：bigram 命中 1 条（见 验证记录）。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;

export function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 标点归一成空格，保留中日韩字符、字母、数字 */
function tokenize(input: string): string {
  return normalize(input).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** 生成索引列：中文/日文按 bigram 展开，拉丁词原样保留 */
export function bigramIndexText(input: string): string {
  const norm = tokenize(input);
  if (!norm) return '';
  const out: string[] = [];
  for (const token of norm.split(' ')) {
    if (token.length === 0) continue;
    if (CJK.test(token)) {
      if (token.length === 1) {
        out.push(token);
      } else {
        for (let i = 0; i < token.length - 1; i++) out.push(token.slice(i, i + 2));
      }
    } else {
      out.push(token);
    }
  }
  return out.join(' ');
}

export interface FtsQuery {
  /** FTS5 MATCH 表达式；null 表示无法用 FTS 表达（例如单个汉字） */
  match: string | null;
  /** 需要 LIKE 兜底的关键词（单个汉字或过短的关键词） */
  likeTerms: string[];
}

/** 把用户输入转成 FTS5 查询：中文按 bigram 短语 AND 连接，拉丁词做前缀匹配 */
export function buildFtsQuery(input: string): FtsQuery {
  const norm = tokenize(input);
  if (!norm) return { match: null, likeTerms: [] };

  const parts: string[] = [];
  const likeTerms: string[] = [];

  for (const token of norm.split(' ')) {
    if (!token) continue;
    if (CJK.test(token)) {
      if (token.length === 1) {
        likeTerms.push(token);
      } else {
        for (let i = 0; i < token.length - 1; i++) {
          parts.push(`"${token.slice(i, i + 2)}"`);
        }
      }
    } else {
      parts.push(`${token}*`);
    }
  }

  return { match: parts.length ? parts.join(' AND ') : null, likeTerms };
}

/** 高亮用：把命中的 bigram 还原成原始关键词（M0 只在标题/路径上做 LIKE 高亮） */
export function cjkRuns(input: string): string[] {
  return normalize(input).match(CJK_RUN) ?? [];
}
