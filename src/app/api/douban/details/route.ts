import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  console.log(`[Douban API] 请求开始 - ID: ${id}, ID类型: ${typeof id}, ID长度: ${id?.length}`);

  if (!id) {
    console.warn(`[Douban API] 缺少ID参数`);
    return NextResponse.json(
      { error: '缺少必要参数: id' },
      { status: 400 }
    );
  }

  // 验证ID格式
  if (!/^\d+$/.test(id)) {
    console.error(`[Douban API] 无效的ID格式: "${id}"`);
    return NextResponse.json(
      { error: '无效的豆瓣ID格式', id: id },
      { status: 400 }
    );
  }

  const target = `https://movie.douban.com/subject/${id}/`;
  console.log(`[Douban API] 目标URL: ${target}`);

  // 重试配置
  const maxRetries = 3;
  const retryDelays = [1000, 2000, 3000]; // 递增延迟

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Douban API] 尝试 ${attempt}/${maxRetries}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(`[Douban API] 请求超时 - 尝试 ${attempt}`);
        controller.abort();
      }, 20000); // 增加到20秒

      // 增强的请求头
      const fetchOptions = {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Referer': 'https://movie.douban.com/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
      };

      const response = await fetch(target, fetchOptions);
      clearTimeout(timeoutId);

      console.log(`[Douban API] 响应状态: ${response.status} - 尝试 ${attempt}`);

      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          console.warn(`[Douban API] 反爬虫检测 ${response.status} - 尝试 ${attempt}`);
          if (attempt < maxRetries) {
            const delay = retryDelays[attempt - 1] + Math.random() * 1000; // 添加随机延迟
            console.log(`[Douban API] 等待 ${Math.round(delay)}ms 后重试`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`[Douban API] HTML获取成功，长度: ${html.length} - 尝试 ${attempt}`);
      
      // 基本验证 - 检查是否是有效的豆瓣页面
      if (!html.includes('douban.com') || html.includes('403 Forbidden') || html.includes('404')) {
        throw new Error('获取到无效页面内容');
      }
      
      // 解析详细信息
      const details = parseDoubanDetails(html, id);

      // 获取缓存时间
      let cacheTime: number;
      try {
        cacheTime = await getCacheTime();
      } catch (configError) {
        console.warn(`[Douban API] 获取缓存配置失败，使用默认值: ${(configError as Error).message}`);
        cacheTime = 7200; // 默认2小时
      }

      console.log(`[Douban API] 请求成功完成 - ID: ${id}`);
      return NextResponse.json(details, {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Netlify-Vary': 'query',
        },
      });

    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error(`[Douban API] 尝试 ${attempt} 失败: ${errorMessage}`);
      
      if (attempt === maxRetries) {
        // 最后一次尝试失败，返回错误
        console.error(`[Douban API] 所有尝试均失败 - ID: ${id}`);
        
        // 根据错误类型返回不同的状态码
        const isTimeoutError = errorMessage.includes('aborted') || errorMessage.includes('timeout');
        const isNetworkError = errorMessage.includes('fetch') || errorMessage.includes('network');
        const isParseError = errorMessage.includes('解析');
        
        let statusCode = 500;
        let userMessage = '获取豆瓣详情失败';
        
        if (isTimeoutError) {
          statusCode = 504;
          userMessage = '请求超时，请稍后重试';
        } else if (isNetworkError) {
          statusCode = 502;
          userMessage = '网络连接失败';
        } else if (isParseError) {
          statusCode = 422;
          userMessage = '页面解析失败';
        }
        
        return NextResponse.json(
          { 
            error: userMessage, 
            details: errorMessage,
            id: id,
            attempts: maxRetries 
          },
          { status: statusCode }
        );
      }
      
      // 不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        const delay = retryDelays[attempt - 1] + Math.random() * 1000;
        console.log(`[Douban API] 等待 ${Math.round(delay)}ms 后进行第 ${attempt + 1} 次尝试`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

function parseDoubanDetails(html: string, id: string) {
  console.log(`[Douban Parse] 开始解析 ID: ${id}, HTML 长度: ${html.length}`);
  
  // 安全提取函数
  const safeExtract = <T>(extractName: string, extractFn: () => T, defaultValue: T) => {
    try {
      const result = extractFn();
      console.log(`[Douban Parse] ${extractName}: 成功`);
      return result;
    } catch (error) {
      console.warn(`[Douban Parse] ${extractName}: 失败 - ${(error as Error).message}`);
      return defaultValue;
    }
  };

  try {
    // 提取基本信息 - 增强容错性
    const title = safeExtract('标题', () => {
      const titleMatch = html.match(/<h1[^>]*>[\s\S]*?<span[^>]*property="v:itemreviewed"[^>]*>([^<]+)<\/span>/) ||
                        html.match(/<title>([^<]+)\s*\(豆瓣\)<\/title>/);
      return titleMatch ? titleMatch[1].trim() : `影片-${id}`;
    }, `影片-${id}`);

    // 提取海报 - 多种模式匹配
    const poster = safeExtract('海报', () => {
      const posterMatch = html.match(/<a[^>]*class="nbgnbg"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"/) ||
                          html.match(/<img[^>]*class="[^"]*"[^>]*src="(https?:\/\/[^"]*doubanio[^"]*)"/) ||
                          html.match(/<img[^>]*src="(https?:\/\/[^"]*doubanio[^"]*)"[^>]*>/);
      return posterMatch ? posterMatch[1] : '';
    }, '');

    // 提取评分 - 兼容不同格式
    const rate = safeExtract('评分', () => {
      const ratingMatch = html.match(/<strong[^>]*class="ll rating_num"[^>]*property="v:average">([^<]+)<\/strong>/) ||
                          html.match(/<span[^>]*class="rating_num">([^<]+)<\/span>/) ||
                          html.match(/property="v:average">([^<]+)<\/[^>]*>/);
      return ratingMatch ? ratingMatch[1].trim() : '';
    }, '');

    // 提取年份 - 多种格式
    const year = safeExtract('年份', () => {
      const yearMatch = html.match(/<span[^>]*class="year">[(]([^)]+)[)]<\/span>/) ||
                        html.match(/(\d{4})/) ||
                        html.match(/<span[^>]*>\((\d{4})\)<\/span>/);
      return yearMatch ? yearMatch[1] : '';
    }, '');

    // 提取导演、编剧、主演 - 增强解析
    const directors = safeExtract('导演', () => {
      const directorMatch = html.match(/<span\s+class=['"]pl['"]>导演<\/span>:\s*<span\s+class=['"]attrs['"]>(.*?)<\/span>/s);
      if (!directorMatch) return [];
      
      const directorLinks = directorMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g);
      if (!directorLinks) return [];
      
      return directorLinks.map(link => {
        const nameMatch = link.match(/>([^<]+)</);
        return nameMatch ? nameMatch[1].trim() : '';
      }).filter(Boolean);
    }, []);

    const screenwriters = safeExtract('编剧', () => {
      const writerMatch = html.match(/<span\s+class=['"]pl['"]>编剧<\/span>:\s*<span\s+class=['"]attrs['"]>(.*?)<\/span>/s);
      if (!writerMatch) return [];
      
      const writerLinks = writerMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g);
      if (!writerLinks) return [];
      
      return writerLinks.map(link => {
        const nameMatch = link.match(/>([^<]+)</);
        return nameMatch ? nameMatch[1].trim() : '';
      }).filter(Boolean);
    }, []);

    const cast = safeExtract('主演', () => {
      const castMatch = html.match(/<span\s+class=['"]pl['"]>主演<\/span>:\s*<span\s+class=['"]attrs['"]>(.*?)<\/span>/s);
      if (!castMatch) return [];
      
      const castLinks = castMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g);
      if (!castLinks) return [];
      
      return castLinks.map(link => {
        const nameMatch = link.match(/>([^<]+)</);
        return nameMatch ? nameMatch[1].trim() : '';
      }).filter(Boolean);
    }, []);

    // 提取类型 - 增强匹配
    const genres = safeExtract('类型', () => {
      const genreMatches = html.match(/<span[^>]*property="v:genre">([^<]+)<\/span>/g);
      if (!genreMatches) return [];
      
      return genreMatches.map(match => {
        const result = match.match(/<span[^>]*property="v:genre">([^<]+)<\/span>/);
        return result ? result[1].trim() : '';
      }).filter(Boolean);
    }, []);

    // 提取制片国家/地区 - 增强解析
    const countries = safeExtract('制片国家/地区', () => {
      const countryMatch = html.match(/<span[^>]*class="pl">制片国家\/地区:<\/span>\s*([^<\n]+)/) ||
                           html.match(/<span[^>]*class="pl">国家\/地区:<\/span>\s*([^<\n]+)/);
      if (!countryMatch) return [];
      
      return countryMatch[1].trim()
        .split(/[/、,]/)
        .map(c => c.trim())
        .filter(Boolean);
    }, []);

    // 提取语言 - 增强解析
    const languages = safeExtract('语言', () => {
      const languageMatch = html.match(/<span[^>]*class="pl">语言:<\/span>\s*([^<\n]+)/);
      if (!languageMatch) return [];
      
      return languageMatch[1].trim()
        .split(/[/、,]/)
        .map(l => l.trim())
        .filter(Boolean);
    }, []);

    // 提取首播/上映日期 - 增强匹配
    const first_aired = safeExtract('首播/上映日期', () => {
      const firstAiredMatch = html.match(/<span\s+class="pl">首播:<\/span>\s*<span[^>]*property="v:initialReleaseDate"[^>]*content="([^"]*)"/) ||
                              html.match(/<span\s+class="pl">上映日期:<\/span>\s*<span[^>]*property="v:initialReleaseDate"[^>]*content="([^"]*)"/) ||
                              html.match(/property="v:initialReleaseDate"[^>]*content="([^"]*)"/);
      return firstAiredMatch ? firstAiredMatch[1] : '';
    }, '');

    // 提取集数 - 更安全的数字解析
    const episodes = safeExtract('集数', () => {
      const episodesMatch = html.match(/<span[^>]*class="pl">集数:<\/span>\s*([^<\n]+)/);
      if (!episodesMatch) return undefined;
      
      const numMatch = episodesMatch[1].trim().match(/(\d+)/);
      return numMatch ? parseInt(numMatch[1]) : undefined;
    }, undefined);

    // 提取时长 - 增强解析
    const { episode_length, movie_duration } = safeExtract('时长', () => {
      let episode_length: number | undefined;
      let movie_duration: number | undefined;
      
      // 单集片长
      const singleEpisodeDurationMatch = html.match(/<span[^>]*class="pl">单集片长:<\/span>\s*([^<\n]+)/);
      if (singleEpisodeDurationMatch) {
        const numMatch = singleEpisodeDurationMatch[1].trim().match(/(\d+)/);
        episode_length = numMatch ? parseInt(numMatch[1]) : undefined;
      }
      
      // 电影片长
      if (!episode_length) {
        const movieDurationMatch = html.match(/<span[^>]*class="pl">片长:<\/span>\s*([^<\n]+)/);
        if (movieDurationMatch) {
          const numMatch = movieDurationMatch[1].trim().match(/(\d+)/);
          movie_duration = numMatch ? parseInt(numMatch[1]) : undefined;
        }
      }
      
      return { episode_length, movie_duration };
    }, { episode_length: undefined, movie_duration: undefined });

    // 提取剧情简介 - 多种模式匹配
    const plot_summary = safeExtract('剧情简介', () => {
      const summaryMatch = html.match(/<span[^>]*class="all hidden">([^<]+)<\/span>/) ||
                           html.match(/<span[^>]*property="v:summary"[^>]*>([^<]+)<\/span>/) ||
                           html.match(/<div[^>]*class="related-info"[\s\S]*?<p>([^<]+)<\/p>/) ||
                           html.match(/<div[^>]*class="intro">[\s\S]*?<p>([^<]+)<\/p>/);
      
      return summaryMatch ? summaryMatch[1].trim().replace(/\s+/g, ' ') : '';
    }, '');

    const result = {
      code: 200,
      message: '获取成功',
      data: {
        id,
        title,
        poster: poster ? poster.replace(/^http:/, 'https:') : '',
        rate,
        year,
        directors,
        screenwriters,
        cast,
        genres,
        countries,
        languages,
        episodes,
        episode_length,
        movie_duration,
        first_aired,
        plot_summary
      }
    };

    console.log(`[Douban Parse] 解析完成: ${title}`);
    return result;

  } catch (error) {
    console.error(`[Douban Parse] 致命错误: ${(error as Error).message}`);
    console.error(`[Douban Parse] 堆栈跟踪: ${(error as Error).stack}`);
    
    // 返回基本信息而不是抛出错误
    return {
      code: 200,
      message: '部分获取成功（解析出错）',
      data: {
        id,
        title: `影片-${id}`,
        poster: '',
        rate: '',
        year: '',
        directors: [],
        screenwriters: [],
        cast: [],
        genres: [],
        countries: [],
        languages: [],
        episodes: undefined,
        episode_length: undefined,
        movie_duration: undefined,
        first_aired: '',
        plot_summary: ''
      }
    };
  }
}