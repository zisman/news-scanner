import re, json, urllib.parse, urllib.request, sys
sys.path.insert(0, ".")
import scan
link = json.load(open("docs/data.json"))["items"]
link = [i["link"] for i in link if "news.google" in i["link"]][0]
gid = re.search(r"/(?:rss/)?(?:articles|read)/([^/?#]+)", link).group(1)
for u in ["https://news.google.com/rss/articles/" + gid, "https://news.google.com/articles/" + gid]:
    try:
        page = scan.fetch(u, 400_000).decode("utf-8", "ignore")
        print(u[:60], len(page), "sg" , bool(re.search(r'data-n-a-sg="', page)), "ts", bool(re.search(r'data-n-a-ts="', page)))
        print(page[:300].replace("\n"," "))
        m = re.search(r'https?://(?!news\.google|www\.google|fonts|www\.gstatic|ssl\.gstatic)[^"\s<>]+', page); print("first ext url:", m and m.group(0)[:120])
    except Exception as e:
        print(u[:60], "ERR", repr(e)[:200])
print("decoded:", scan.google_real_url(link))
