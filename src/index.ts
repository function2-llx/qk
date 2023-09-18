import fs from 'fs'
import path from 'path'
import { URL, URLSearchParams } from 'url'
import readline from 'readline'

import axios, { AxiosResponse } from 'axios'
import puppeteer, { Page } from 'puppeteer'
import yaml from 'js-yaml'
import winston, { info, log } from 'winston'
import { DateTime } from 'luxon'

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: () => DateTime.now().toISO()! }),
        winston.format.printf(({level, message, timestamp}) => `${timestamp} [${level.toUpperCase()}] ${message}`),
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'qk.log' }),
    ]
});

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface Conf {
    auth: {
        username: string
        password: string
    }
    chaojiying: {
        user: string
        pass2: string
        softid: string
    }
    semester: string
    学位课: boolean
    courses: Record<string, string[]>
}

interface ChaojiyingResult {
    err_no: number
    err_str: string
    pic_id: string
    pic_str: string
    md5: string
}

const conf = yaml.load(fs.readFileSync('conf.yaml', 'utf-8')) as Conf;
console.log(conf);
// const fateadm = new FateaDM(conf.fateadm.pd_id, conf.fateadm.pd_key);
const resultsFolder = 'results' as const;
if (!fs.existsSync(resultsFolder)) fs.mkdirSync(resultsFolder);

puppeteer.launch({headless: 'new'}).then(async browser => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    async function login(): Promise<Page> {
        const MAIN_URL = 'https://zhjwxk.cic.tsinghua.edu.cn/xkYjs.vxkYjsXkbBs.do?m=main';
        // const page = await browser.newPage();
        const page = (await browser.pages())[0];
        await page.goto(MAIN_URL);
        if (page.url() != MAIN_URL) {
            async function getCaptcha() {
                for (;;) {
                    const res = await page.goto('https://zhjwxk.cic.tsinghua.edu.cn/login-jcaptcah.jpg?captchaflag=login1', );
                    if (res === null) {
                        await delay(1000);
                        continue;
                    }
                    const buffer = await res.buffer();
                    fs.writeFileSync('captcha.jpg', buffer);
                    const captcha = await axios.post(
                        'http://upload.chaojiying.net/Upload/Processing.php',
                        {
                            'user': conf.chaojiying.user,
                            'pass2': conf.chaojiying.pass2,
                            'softid': conf.chaojiying.softid,
                            'codetype': '1902',
                            'len_min': 4,
                            'file_base64': buffer.toString('base64'),
                        },
                        {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:24.0) Gecko/20100101 Firefox/24.0',
                                'Content-Type' : 'application/x-www-form-urlencoded',
                            },
                            timeout: 60000,
                        }
                    ).then(async (res: AxiosResponse<ChaojiyingResult>) => {
                        if (res.status == 200) {
                            const result = res.data;
                            console.log(result);
                            if (result.err_no == 0) return result.pic_str.toUpperCase();
                            else {
                                logger.info('验证码识别接口失败');
                                await delay(1000);
                                return null;
                            }
                        } else {
                            logger.info('未知验证码识别接口调用异常');
                            await delay(1000);
                            return null;
                        }
                    }).catch(async e => {
                        logger.info(`验证码识别接口调用异常：${e}`);
                        await delay(1000);
                        return null;
                    });
                    if (captcha === null) continue;
                    return captcha;
                }
            }
            for (;;) {
                await page.goto('https://zhjwxk.cic.tsinghua.edu.cn/xklogin.do');
                const captcha = await getCaptcha();
                logger.info(`得到验证码：${captcha}`);
                const authUrl = new URL('https://zhjwxk.cic.tsinghua.edu.cn/j_acegi_formlogin_xsxk.do');
                authUrl.search = new URLSearchParams({
                    j_username: conf.auth.username,
                    j_password: conf.auth.password,
                    captchaflag: 'login1',
                    _login_image_: captcha,
                }).toString();
                await page.goto(authUrl.toString());
                if (page.url() == MAIN_URL) {
                    fs.renameSync('captcha.jpg', path.join(resultsFolder, `${captcha}.jpg`));
                    break;
                }
                logger.info('登录失败，稍后重试');
                await delay(10000);
            }
        }
        logger.info('登录成功');
        return page;
    }

    while (Object.keys(conf.courses).length > 0) {
        try {
            const page = await login();
            await delay(1000);
            // 获取“选课操作-选课”对应链接
            const courseLink = conf.学位课 ? 
            `https://zhjwxk.cic.tsinghua.edu.cn/xkYjs.vxkYjsXkbBs.do?m=xwkSearch&p_xnxq=${conf.semester}&tokenPriFlag=xwk` :
            `https://zhjwxk.cic.tsinghua.edu.cn/xkYjs.vxkYjsXkbBs.do?m=fxwkSearch&p_xnxq=${conf.semester}&tokenPriFlag=fxwk`;
            await page.goto(courseLink);
            while (Object.keys(conf.courses).length > 0) {
                const submitOk = await new Promise(async resolve => {
                    // 首先注册提交后对话框处理逻辑
                    page.once('dialog', async dialog => {
                        const msg = dialog.message();
                        logger.info(`提交信息：${msg}`);
                        for (const [课程号, 课序号列表] of Object.entries(conf.courses)) {
                            const 课序号 = 课序号列表.find(课序号 => !msg.includes(`${课程号} ${课序号}`));
                            if (课序号 === undefined) {
                                logger.info(`${课程号} 提交选课失败`);
                            } else {
                                logger.info(`${课程号} 提交选课成功`);
                                delete conf.courses[课程号];
                            }
                        }
                        page.screenshot({ path: 'screenshot.png' });
                        await dialog.accept();
                        resolve(true);
                    });
                    // 处理提交后出现的异常情况（主要是登录掉线）
                    page.once('response', res => { if (res.status() != 200) resolve(false); });
                    for (const [课程号, 课序号列表] of Object.entries(conf.courses)) {
                        for (let 课序号 of 课序号列表) {
                            await page.waitForSelector(`xpath/.//*[@value="${conf.semester};${课程号};${课序号};"]`).then(x => x!.click());
                        }
                    }
                    await page.waitForSelector('xpath/.//*[@id="a"]/div/div/div[2]/div[2]/input').then(x => x!.click());
                    logger.info('点击提交');
                    // 处理一些奇怪的未响应情况
                    setTimeout(() => resolve(false), 10000);
                });
                if (submitOk) await delay(2000);
                else throw new Error('状态异常，重新登录');
            }
        } catch (e) {
            logger.info(e);
            await delay(2000);
        }
    }

    browser.close();
    rl.close();
});
