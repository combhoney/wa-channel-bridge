// scraper.js
import fs from 'fs';

const WEBSITES = [
    "https://bdgovtjob.net/wp-json/wp/v2/posts",
    "https://bdgovtnotice.com/wp-json/wp/v2/posts",
    "https://projobsbd.com/wp-json/wp/v2/posts"
];

// HTML ট্যাগ রিমুভ করার ফাংশন
function cleanHTML(html) {
    return html.replace(/<[^>]*>?/gm, '').replace(/\n\s*\n/g, '\n').trim();
}

export async function fetchLastTwoMonthsJobs() {
    console.log("🔄 গত ২ মাসের চাকরির ডাটা কালেকশন শুরু হচ্ছে...");
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 60); // ৬০ দিন আগের তারিখ

    let allJobs = [];

    for (const site of WEBSITES) {
        let page = 1;
        let keepFetching = true;

        while (keepFetching && page <= 5) { // প্রতি পেজে ২০টি করে সর্বোচ্চ ৫ পেজ (১০০ পোস্ট)
            try {
                const url = `${site}?per_page=20&page=${page}`;
                const res = await fetch(url);
                if (!res.ok) break;

                const posts = await res.json();
                if (!posts || posts.length === 0) break;

                for (const post of posts) {
                    const postDate = new Date(post.date);

                    // ৬০ দিনের চেয়ে পুরনো পোস্টে পৌঁছালে লুপ থামিয়ে দেবে
                    if (postDate < twoMonthsAgo) {
                        keepFetching = false;
                        break;
                    }

                    allJobs.push({
                        title: post.title.rendered,
                        date: post.date.split('T')[0],
                        details: cleanHTML(post.excerpt?.rendered || post.content?.rendered || "").slice(0, 300), // প্রথম ৩০০ অক্ষর
                        link: post.link
                    });
                }
                page++;
            } catch (err) {
                console.error(`Error fetching from ${site}:`, err.message);
                break;
            }
        }
    }

    // ফাইলে সেভ রাখা
    fs.writeFileSync('./jobs.json', JSON.stringify(allJobs, null, 2));
    console.log(`✅ সফলভাবে মোট ${allJobs.length} টি চলতি সার্কুলার সেভ করা হয়েছে!`);
    return allJobs;
}
