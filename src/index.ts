import fs from 'fs'
import path from 'path'
import { URL, URLSearchParams } from 'url'
import readline from 'readline'

import puppeteer, { Page } from 'puppeteer'
import { FateaDM } from 'fateadm'
import yaml from 'js-yaml'
import winston, { info } from 'winston'
import { DateTime } from 'luxon'

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: () => DateTime.now().toISO() }),
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
    fateadm: {
        pd_id: string
        pd_key: string
    }
    courses: string[]
}

const conf = <Conf>yaml.load(fs.readFileSync('conf.yaml', 'utf-8'));
console.log(conf);
const fateadm = new FateaDM(conf.fateadm.pd_id, conf.fateadm.pd_key);
const resultsFolder = 'results' as const;
if (!fs.existsSync(resultsFolder)) fs.mkdirSync(resultsFolder);

puppeteer.launch().then(async browser => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    async function login(): Promise<Page> {
        const MAIN_URL = 'http://zhjwxk.cic.tsinghua.edu.cn/xkYjs.vxkYjsXkbBs.do?m=main';
        const page = await browser.newPage();
        await page.goto(MAIN_URL);
        if (page.url() != MAIN_URL) {
            async function getCaptcha() {
                const res = await page.goto('http://zhjwxk.cic.tsinghua.edu.cn/login-jcaptcah.jpg?captchaflag=login1');
                const buffer = await res.buffer();
                fs.writeFileSync('captcha.jpg', buffer);
                const result = await fateadm.recognize(buffer.toString('base64'), '30500');
                const captcha = result.Result.toUpperCase();
                // const captcha = await new Promise(resolve => rl.question('?????????????????????: ', answer => resolve(answer.toUpperCase())));
                return captcha as string;
            };
            for (;;) {
                await page.goto('http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do');
                const captcha = await getCaptcha();
                logger.info(`??????????????????${captcha}`);
    
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
                logger.info('???????????????????????????');
                await delay(1000);
            }
        }
        logger.info('????????????');
        return page;
    }
    const success: string[] = [];
    while (success.length < conf.courses.length) {
        try {
            const page = await login();
            // ?????????????????????-?????????????????????
            await page.frames().find(frame => frame.name() == 'tree')!
                .waitForXPath('//*[@id="show"]/li[2]/a')
                .then(xk => xk!.getProperty('href'))
                .then(prop => prop!.jsonValue())
                .then(href => page.goto(href as string));
            // // ??????????????????????????????????????????
            // await page.waitForXPath('//*[@id="iframe1"]')
            //     .then(iframe => iframe!.getProperty('src'))
            //     .then(prop => prop!.jsonValue())
            //     .then(src => page.goto(src as string));
            const coursesFrame = await page.frames().find(frame => frame.name() == 'fcxkFrm')!;

            while (success.length < conf.courses.length) {
                for (let course of conf.courses) {
                    if (success.includes(course)) continue;
                    logger.info(`?????????????????????${course}`);
                    const submitOk = await new Promise(async resolve => {
                        // ??????????????????????????????????????????
                        page.once('dialog', async dialog => {
                            const msg = dialog.message();
                            logger.info(`${course} ???????????????${msg}`);
                            page.screenshot({ path: 'screenshot.png' });
                            if (msg == '??????????????????;') {
                                success.push(course);
                                logger.info(`${course} ????????????\n`);
                            } else {
                                logger.info(`${course} ????????????\n`);
                            }
                            await dialog.accept();
                            resolve(true);
                        });
                        // ???????????????????????????????????????????????????????????????
                        page.waitForResponse
                        page.once('response', res => { if (res.status() != 200) resolve(false); });
                        // ????????????
                        await coursesFrame.waitForXPath(`//*[@value="${course}"]`).then(x => x!.click());
                        // ????????????
                        await coursesFrame.waitForXPath('//*[@id="a"]/div/div/div[2]/div[2]/input').then(x => x!.click());
                        // ????????????????????????????????????
                        setTimeout(() => resolve(false), 30000);
                        logger.info('????????????');
                    });
                    if (submitOk) await delay(1000);
                    else throw new Error('???????????????????????????');
                }
            }
        } catch (e) {
            logger.info(e);
            await delay(2000);
        }
    }

    browser.close();
    rl.close();
});
