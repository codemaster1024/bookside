// 微信读书 Agent API Gateway 的最小客户端。接口说明见 github.com/Tencent/WeChatReading 的 skills/*.md。
import { describeFetchError } from "../http.ts";

export const GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
/** 对应官方 skills/SKILL.md 的 version；服务端据此判断是否需要升级。 */
export const SKILL_VERSION = "1.0.5";

export class WereadError extends Error {
  readonly errcode: number;

  constructor(apiName: string, errcode: number, message: string) {
    super(`微信读书 ${apiName} 出错（${errcode}）：${message}`);
    this.name = "WereadError";
    this.errcode = errcode;
  }
}

/** 服务端要求升级协议版本；此时必须停下，不能继续同步。 */
export class WereadUpgradeRequired extends Error {
  constructor(message: string) {
    super(`微信读书接口要求升级：${message}`);
    this.name = "WereadUpgradeRequired";
  }
}

export type NotebookEntry = {
  bookId: string;
  book: { title: string; author?: string; cover?: string };
  reviewCount: number;
  noteCount: number;
  readingProgress?: number;
  markedStatus?: number;
  sort: number;
};

export type ShelfBook = {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  finishReading?: number;
  readUpdateTime?: number;
  /** 分类，如「文学-外国文学」。 */
  category?: string;
};

export type WereadChapter = { chapterUid: number; chapterIdx: number; title: string };

export type WereadBookmark = {
  bookmarkId: string;
  chapterUid?: number;
  markText: string;
  createTime: number;
  range?: string;
};

export type WereadReview = {
  reviewId: string;
  content: string;
  abstract?: string;
  range?: string;
  chapterUid?: number;
  createTime: number;
  /** 0–5，-1 表示无评分。 */
  star?: number;
};

/** 书城接口给的多是 70 像素宽的小图（s_ 前缀）；换成和书架一样的 250 像素版本（t6_）。 */
export function normalizeCover(url: string | undefined): string | undefined {
  return url?.replace(/\/s_([^/]+)$/, "/t6_$1");
}

/** 书城里的一本书：搜索结果或书籍详情。 */
export type CatalogBook = {
  bookId: string;
  title: string;
  author?: string;
  intro?: string;
  cover?: string;
  /** 评分，百分制。 */
  rating?: number;
};

/** 目录中的一章；level 1 为一级标题。 */
export type TocEntry = WereadChapter & { level: number };

/** 热门划线：原文与划线人数。 */
export type PopularHighlight = { chapterUid?: number; markText: string; count: number };

/** 导读所需的书城能力；测试里用假实现替换。 */
export interface WereadCatalog {
  search(keyword: string): Promise<CatalogBook[]>;
  bookInfo(bookId: string): Promise<CatalogBook>;
  toc(bookId: string): Promise<TocEntry[]>;
  /** 全书（或某一章）最热门的划线，服务端最多返回 20 条。 */
  popularHighlights(bookId: string, chapterUid?: number): Promise<PopularHighlight[]>;
}

/** 同步所需的数据源能力；测试里用假实现替换。 */
export interface WereadSource {
  shelf(): Promise<ShelfBook[]>;
  notebooks(): Promise<NotebookEntry[]>;
  bookmarks(bookId: string): Promise<{ bookmarks: WereadBookmark[]; chapters: WereadChapter[] }>;
  myReviews(bookId: string): Promise<WereadReview[]>;
}

type Fetch = typeof fetch;

export class WereadClient implements WereadSource, WereadCatalog {
  private readonly apiKey: string;
  private readonly fetchImpl: Fetch;

  constructor(apiKey: string, fetchImpl: Fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async call<T>(apiName: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(GATEWAY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      // 业务参数必须与 api_name 平铺在同一层。
      body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VERSION }),
    }).catch((e: unknown) => {
      throw new WereadError(apiName, -1, `无法连接：${describeFetchError(e)}`);
    });
    if (!res.ok) throw new WereadError(apiName, res.status, res.statusText);
    const body = (await res.json()) as { errcode?: number; errmsg?: string; upgrade_info?: { message?: string } };
    if (body.upgrade_info) throw new WereadUpgradeRequired(body.upgrade_info.message ?? "");
    if (body.errcode) throw new WereadError(apiName, body.errcode, body.errmsg ?? "");
    return body as T;
  }

  async shelf(): Promise<ShelfBook[]> {
    return (await this.call<{ books?: ShelfBook[] }>("/shelf/sync")).books ?? [];
  }

  async notebooks(): Promise<NotebookEntry[]> {
    const all: NotebookEntry[] = [];
    let lastSort: number | undefined;
    for (;;) {
      const page = await this.call<{ books?: NotebookEntry[]; hasMore?: number }>("/user/notebooks", {
        count: 100,
        ...(lastSort === undefined ? {} : { lastSort }),
      });
      const books = page.books ?? [];
      all.push(...books);
      if (page.hasMore !== 1 || books.length === 0) return all;
      lastSort = books.at(-1)!.sort;
    }
  }

  async bookmarks(bookId: string) {
    const body = await this.call<{ updated?: WereadBookmark[]; chapters?: WereadChapter[] }>("/book/bookmarklist", {
      bookId,
    });
    return { bookmarks: body.updated ?? [], chapters: body.chapters ?? [] };
  }

  async myReviews(bookId: string): Promise<WereadReview[]> {
    const all: WereadReview[] = [];
    let synckey = 0;
    for (;;) {
      const page = await this.call<{ reviews?: { review: WereadReview }[]; hasMore?: number; synckey?: number }>(
        "/review/list/mine",
        { bookid: bookId, synckey, count: 100 },
      );
      const reviews = page.reviews ?? [];
      all.push(...reviews.map((r) => r.review));
      if (page.hasMore !== 1 || reviews.length === 0 || page.synckey === undefined) return all;
      synckey = page.synckey;
    }
  }

  async search(keyword: string): Promise<CatalogBook[]> {
    type Hit = { bookInfo: { bookId: string; title: string; author?: string; intro?: string; cover?: string; soldout?: number } };
    const body = await this.call<{ results?: { books?: Hit[] }[] }>("/store/search", { keyword, scope: 10 });
    return (body.results ?? [])
      .flatMap((g) => g.books ?? [])
      .filter((h) => h.bookInfo?.bookId && !h.bookInfo.soldout)
      .map(({ bookInfo: b }) => ({ bookId: b.bookId, title: b.title, author: b.author, intro: b.intro, cover: normalizeCover(b.cover) }));
  }

  async bookInfo(bookId: string): Promise<CatalogBook> {
    const b = await this.call<{ bookId: string; title: string; author?: string; intro?: string; cover?: string; newRating?: number }>(
      "/book/info",
      { bookId },
    );
    return { bookId: b.bookId ?? bookId, title: b.title, author: b.author, intro: b.intro, cover: normalizeCover(b.cover), rating: b.newRating };
  }

  async toc(bookId: string): Promise<TocEntry[]> {
    const body = await this.call<{ chapters?: (WereadChapter & { level?: number })[] }>("/book/chapterinfo", { bookId });
    return (body.chapters ?? []).map((c) => ({ chapterUid: c.chapterUid, chapterIdx: c.chapterIdx, title: c.title, level: c.level ?? 1 }));
  }

  async popularHighlights(bookId: string, chapterUid?: number): Promise<PopularHighlight[]> {
    const body = await this.call<{ items?: { chapterUid?: number; markText: string; totalCount?: number }[] }>(
      "/book/bestbookmarks",
      { bookId, ...(chapterUid === undefined ? {} : { chapterUid }) },
    );
    return (body.items ?? []).map((i) => ({ chapterUid: i.chapterUid, markText: i.markText, count: i.totalCount ?? 0 }));
  }
}
