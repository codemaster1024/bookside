import { describe, expect, it } from "vitest";
import { GATEWAY_URL, SKILL_VERSION, WereadClient, WereadError, WereadUpgradeRequired, normalizeCover } from "./client.ts";

function fakeFetch(responses: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    expect(url).toBe(GATEWAY_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer wrk-test");
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(responses.shift()));
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe("WereadClient", () => {
  it("sends business params flat next to api_name and skill_version", async () => {
    const f = fakeFetch([{ updated: [], chapters: [] }]);
    await new WereadClient("wrk-test", f.impl).bookmarks("B1");
    expect(f.bodies[0]).toEqual({ api_name: "/book/bookmarklist", bookId: "B1", skill_version: SKILL_VERSION });
  });

  it("pages notebooks with lastSort until hasMore is 0", async () => {
    const book = (id: string, sort: number) => ({ bookId: id, book: { title: id }, noteCount: 1, reviewCount: 0, sort });
    const f = fakeFetch([
      { books: [book("a", 9), book("b", 7)], hasMore: 1 },
      { books: [book("c", 3)], hasMore: 0 },
    ]);
    const all = await new WereadClient("wrk-test", f.impl).notebooks();
    expect(all.map((b) => b.bookId)).toEqual(["a", "b", "c"]);
    expect(f.bodies[1]).toMatchObject({ lastSort: 7 });
    expect(f.bodies[0]).not.toHaveProperty("lastSort");
  });

  it("pages my reviews with synckey", async () => {
    const rv = (id: string) => ({ review: { reviewId: id, content: id, createTime: 1 } });
    const f = fakeFetch([
      { reviews: [rv("1")], hasMore: 1, synckey: 42 },
      { reviews: [rv("2")], hasMore: 0, synckey: 43 },
    ]);
    const all = await new WereadClient("wrk-test", f.impl).myReviews("B1");
    expect(all.map((r) => r.reviewId)).toEqual(["1", "2"]);
    expect(f.bodies[1]).toMatchObject({ bookid: "B1", synckey: 42 });
  });

  it("stops on upgrade_info and surfaces errcode", async () => {
    await expect(
      new WereadClient("wrk-test", fakeFetch([{ upgrade_info: { message: "请升级" } }]).impl).shelf(),
    ).rejects.toThrow(WereadUpgradeRequired);
    await expect(
      new WereadClient("wrk-test", fakeFetch([{ errcode: -2012, errmsg: "登录超时" }]).impl).shelf(),
    ).rejects.toThrow(WereadError);
  });
});

describe("normalizeCover", () => {
  it("swaps the 70px catalog thumbnail for the 250px version", () => {
    expect(normalizeCover("https://cdn.weread.qq.com/weread/cover/39/YueWen_1/s_YueWen_1.jpg")).toBe(
      "https://cdn.weread.qq.com/weread/cover/39/YueWen_1/t6_YueWen_1.jpg",
    );
    expect(normalizeCover("https://x/cover/1/t6_a.jpg")).toBe("https://x/cover/1/t6_a.jpg");
    expect(normalizeCover(undefined)).toBeUndefined();
  });
});
