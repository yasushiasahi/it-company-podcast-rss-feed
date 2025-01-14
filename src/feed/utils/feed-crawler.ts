import RssParser from 'rss-parser';
import { PromisePool } from '@supercharge/promise-pool';
import { FeedInfo } from '../../resources/feed-info-list';
import dayjs from 'dayjs';
import { URL } from 'url';
import {
  isValidHttpUrl,
  objectDeepCopy,
  removeInvalidUnicode,
  exponentialBackoff,
  urlRemoveQueryParams,
} from './common-util';
import { logger } from './logger';
import constants from '../../common/constants';
import eleventyCacheOption from '../../common/eleventy-cache-option';
import { to } from 'await-to-js';
const ogs = require('open-graph-scraper');
const EleventyFetch = require('@11ty/eleventy-fetch');

export type OgsResult = {
  ogTitle: string;
  ogType: string;
  ogUrl: string;
  ogAudio?: string;
  ogDescription: string;
  favicon: string;
  requestUrl: string;
  ogImage: {
    url: string;
    width: string;
    height: string;
    type: string;
  };
};
export type OgsResultMap = Map<string, OgsResult>;
export type CustomRssParserItem = RssParser.Item & {
  link: string;
  audioUrl: string;
  isoDate: string;
  blogTitle: string;
  blogLink: string;
  itunes?: {
    image: string;
    duration: string;
  };
};
export type CustomRssParserFeed = RssParser.Output<CustomRssParserItem> & {
  link: string;
  title: string;
};

export class FeedCrawler {
  private rssParser;

  constructor() {
    this.rssParser = new RssParser({
      maxRedirects: 5,
      timeout: 1000 * 10,
      headers: {
        'user-agent': constants.requestUserAgent,
      },
    });
  }

  /**
   * フィード取得 + 取得後の調整
   */
  async fetchFeedsAsync(feedInfoList: FeedInfo[], concurrency: number): Promise<CustomRssParserFeed[]> {
    FeedCrawler.validateFeedInfoList(feedInfoList);

    const feedInfoListLength = feedInfoList.length;
    let fetchProcessCounter = 1;

    const feeds: CustomRssParserFeed[] = [];
    const feedLinkSet = new Set<string>();

    await PromisePool.for(feedInfoList)
      .withConcurrency(concurrency)
      .process(async (feedInfo) => {
        const [error, feed] = await to(
          exponentialBackoff(() => {
            return this.rssParser.parseURL(feedInfo.url);
          }),
        );
        if (error) {
          logger.error(
            '[fetch-feed] error',
            `${fetchProcessCounter++}/${feedInfoListLength}`,
            feedInfo.label,
            feedInfo.url,
          );
          logger.trace(error);
          return;
        }

        const postProcessedFeed = FeedCrawler.postProcessFeed(feedInfo, feed as CustomRssParserFeed);

        // フィードのリンクの重複チェック。すでにあったらスキップ
        if (feedLinkSet.has(postProcessedFeed.link)) {
          logger.warn('フィードのリンクが重複しているのでスキップしました ', feedInfo.label, postProcessedFeed.link);
          return;
        }
        feedLinkSet.add(postProcessedFeed.link);

        feeds.push(postProcessedFeed);
        logger.info('[fetch-feed] fetched', `${fetchProcessCounter++}/${feedInfoListLength}`, feedInfo.label);
      });

    logger.info('[fetch-feed] finished');

    return feeds;
  }

  /**
   * フィード情報のチェック
   */
  public static validateFeedInfoList(feedInfoList: FeedInfo[]): void {
    const allLabels = feedInfoList.map((feedInfo) => {
      return feedInfo.label + ':' + feedInfo.flags?.map((flag: symbol) => flag.toString()).join(',');
    });
    const allUrls = feedInfoList.map((feedInfo) => feedInfo.url);

    const labelSet = new Set<string>();
    const urlSet = new Set<string>();

    // label の重複チェック
    for (const label of allLabels) {
      if (labelSet.has(label)) {
        throw new Error(`フィードのラベル「${label}」が重複しています`);
      }
      labelSet.add(label);
    }

    // url の重複チェック
    for (const url of allUrls) {
      if (urlSet.has(url)) {
        throw new Error(`フィードのURL「${url}」が重複しています`);
      }
      urlSet.add(url);
    }
  }

  /**
   * 取得したフィードの調整
   */
  private static postProcessFeed(feedInfo: FeedInfo, feed: CustomRssParserFeed): CustomRssParserFeed {
    const customFeed = feed;

    // 番組ごとの調整
    // switch (feedInfo.label) {
    //   case 'メルカリ':
    //     break;
    // }

    if (!isValidHttpUrl(customFeed.link)) {
      logger.warn('取得したフィードのURLが正しくありません。 ', feedInfo.label, customFeed.link);
    }

    if (customFeed.items.length === 0) {
      logger.warn('取得したフィードの記事ががありません', feedInfo.label);
    }

    // 全ブログの調整
    for (const feedItem of customFeed.items) {
      feedItem.link = feedItem.link || '';

      // 記事URLのクエリパラメーター削除。はてな用
      feedItem.link = urlRemoveQueryParams(feedItem.link);

      // 不正な文字列の削除
      feedItem.title = feedItem.title ? removeInvalidUnicode(feedItem.title) : '';
      feedItem.summary = feedItem.summary ? removeInvalidUnicode(feedItem.summary) : '';
      feedItem.content = feedItem.content ? removeInvalidUnicode(feedItem.content) : '';
      feedItem.contentSnippet = feedItem.contentSnippet ? removeInvalidUnicode(feedItem.contentSnippet) : '';
      feedItem.creator = feedItem.creator ? removeInvalidUnicode(feedItem.creator) : '';
      feedItem.categories = feedItem.categories?.map(removeInvalidUnicode) || [];

      // view用
      feedItem.blogTitle = customFeed.title || '';
      feedItem.blogLink = customFeed.link || '';
      feedItem.audioUrl = feedItem.enclosure?.url || '';
    }

    return customFeed;
  }

  aggregateFeeds(feeds: CustomRssParserFeed[], filterArticleDate: Date) {
    let allFeedItems: CustomRssParserItem[] = [];
    const copiedFeeds: CustomRssParserFeed[] = objectDeepCopy(feeds);
    const filterIsoDate = filterArticleDate.toISOString();

    for (const feed of copiedFeeds) {
      // 公開日時でフィルタ
      feed.items = feed.items.filter((feedItem) => {
        if (!feedItem.isoDate) {
          return false;
        }

        return feedItem.isoDate >= filterIsoDate;
      });

      // マージ
      allFeedItems = allFeedItems.concat(feed.items);
    }

    // 日付でソート
    allFeedItems.sort((a, b) => {
      return -1 * a.isoDate.localeCompare(b.isoDate);
    });

    return allFeedItems;
  }

  fetchFeedItemOgsResultMap(feedItems: CustomRssParserItem[]): OgsResultMap {
    const feedItemOgsResultMap: OgsResultMap = new Map();

    feedItems.forEach((feedItem) => {
      if (feedItem.enclosure?.url === undefined) {
        return;
      }
      const ogsResult = FeedCrawler.generateOgsResultFromPodcastItem(feedItem);
      feedItemOgsResultMap.set(feedItem.enclosure.url, ogsResult);
    });

    logger.info('[fetch-feed-item-og] finished');
    return feedItemOgsResultMap;
  }

  async fetchFeedBlogOgsResultMap(feeds: CustomRssParserFeed[], concurrency: number): Promise<OgsResultMap> {
    const feedOgsResultMap: OgsResultMap = new Map();
    const feedsLength = feeds.length;
    let fetchProcessCounter = 1;

    await PromisePool.for(feeds)
      .withConcurrency(concurrency)
      .process(async (feed) => {
        const [error, ogsResult] = await to(
          exponentialBackoff(() => {
            return FeedCrawler.generateOgsResultFromPodcastFeed(feed);
          }),
        );
        if (error) {
          logger.error('[fetch-feed-blog-og] error', `${fetchProcessCounter++}/${feedsLength}`, feed.title, feed.link);
          logger.trace(error);
          return;
        }

        feedOgsResultMap.set(feed.link, ogsResult);
        logger.info('[fetch-feed-blog-og] fetched', `${fetchProcessCounter++}/${feedsLength}`, feed.title);
      });

    logger.info('[fetch-feed-blog-og] finished');

    return feedOgsResultMap;
  }

  private static async generateOgsResultFromPodcastFeed(feed: CustomRssParserFeed): Promise<OgsResult> {
    const ogDescription = feed.description || '';
    const url = feed.link || '';
    const ogsResult: OgsResult = {
      ogTitle: feed.title || '',
      ogType: 'article',
      ogUrl: url,
      ogDescription,
      favicon: '',
      requestUrl: url,
      ogImage: {
        url: feed.itunes?.image || '',
        width: '',
        height: '',
        type: '',
      },
    };

    return ogsResult;
  }

  private static generateOgsResultFromPodcastItem(feedItem: CustomRssParserItem): OgsResult {
    const ogDescription = feedItem.contentSnippet || feedItem.summary || '';
    const ogAudio = feedItem.enclosure?.url;
    const ogUrl = feedItem.link || ogAudio || '';
    const ogsResult: OgsResult = {
      ogTitle: feedItem.title || '',
      ogType: 'article',
      ogUrl: ogUrl,
      ogAudio,
      ogDescription,
      favicon: '',
      requestUrl: ogUrl || ogAudio || '',
      ogImage: {
        url: feedItem.itunes?.image || '',
        width: '',
        height: '',
        type: '',
      },
    };

    return ogsResult;
  }

  private static async fetchOgsResult(url: string): Promise<OgsResult> {
    const [error, ogsResponse] = await to<{ result: OgsResult }>(
      ogs({
        url: url,
        timeout: 10 * 1000,
        // 10MB
        downloadLimit: 10 * 1000 * 1000,
        retry: 3,
        headers: {
          'user-agent': constants.requestUserAgent,
        },
      }),
    );
    if (error) {
      return Promise.reject(
        new Error(`OGの取得に失敗しました。 url: ${url}`, {
          cause: error,
        }),
      );
    }

    const ogsResult = ogsResponse.result;
    const ogImageUrl = ogsResult?.ogImage?.url;

    // 一部URLがおかしいものの対応
    if (ogImageUrl && ogImageUrl.startsWith('https://tech.fusic.co.jphttps')) {
      ogsResult.ogImage.url = ogImageUrl.substring('https://tech.fusic.co.jp'.length);
    }

    // http から始まってなければ調整
    if (ogImageUrl && !ogImageUrl.startsWith('http')) {
      ogsResult.ogImage.url = new URL(ogImageUrl, url).toString();
    }

    return ogsResponse.result;
  }

  async fetchAndCacheOgImages(
    allFeedItems: CustomRssParserItem[],
    ogsResultMap: OgsResultMap,
    feeds: CustomRssParserFeed[],
    concurrency: number,
  ): Promise<void> {
    let ogImageUrls: string[] = [];

    for (const feedItem of allFeedItems) {
      ogImageUrls.push(ogsResultMap.get(feedItem.link)?.ogImage?.url || '');
    }

    for (const feed of feeds) {
      ogImageUrls.push(ogsResultMap.get(feed.link)?.ogImage?.url || '');
    }

    // フィルタ
    ogImageUrls = ogImageUrls.filter(Boolean);

    // 画像取得
    const ogImageUrlsLength = ogImageUrls.length;
    let fetchProcessCounter = 1;

    EleventyFetch.concurrency = concurrency;

    await PromisePool.for(ogImageUrls)
      .withConcurrency(concurrency)
      .process(async (ogImageUrl) => {
        const [error] = await to(EleventyFetch(ogImageUrl, eleventyCacheOption));
        if (error) {
          logger.error('[cache-og-image] error', `${fetchProcessCounter++}/${ogImageUrlsLength}`, ogImageUrl);
          logger.trace(error);
          return;
        }

        logger.info('[cache-og-image] fetched', `${fetchProcessCounter++}/${ogImageUrlsLength}`, ogImageUrl);
      });

    logger.info('[cache-og-image] finished');
  }

  private static subtractFeedItemsDateHour(feed: CustomRssParserFeed, subHours: number) {
    for (const feedItem of feed.items) {
      feedItem.isoDate = dayjs(feedItem.isoDate).subtract(subHours, 'h').toISOString();
      feedItem.pubDate = dayjs(feedItem.pubDate).subtract(subHours, 'h').toISOString();
    }
  }
}
