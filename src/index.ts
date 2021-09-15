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
            for (;;) {
                await page.goto('http://zhjwxk.cic.tsinghua.edu.cn/xklogin.do');
                const res = await page.goto('http://zhjwxk.cic.tsinghua.edu.cn/login-jcaptcah.jpg?captchaflag=login1');
                const buffer = await res.buffer();
                fs.writeFileSync('captcha.jpg', buffer);
                // const result = await fateadm.recognize(buffer.toString('base64'), '30500');
                // const captcha = result.Result.toUpperCase();
                const captcha: string = await new Promise(resolve => rl.question('manual captcha: ', answer => resolve(answer.toUpperCase())));
                logger.info(`验证码：${captcha}`);
    
                const authUrl = new URL('https://zhjwxk.cic.tsinghua.edu.cn/j_acegi_formlogin_xsxk.do');
                authUrl.search = new URLSearchParams({
                    j_username: conf.auth.username,
                    j_password: conf.auth.password,
                    captchaflag: 'login1',
                    _login_image_: captcha,
                }).toString();
                await page.goto(authUrl.toString());
                if (page.url() == MAIN_URL) {
                    fs.writeFileSync(path.join(resultsFolder, `${captcha}.jpg`), buffer);
                    break;
                }
                logger.info('登录失败，稍后重试');
                await delay(1000);
            }
        }
        logger.info('登录成功');
        return page;
    }
    const success: string[] = [];
    while (success.length < conf.courses.length) {
        try {
            const page = await login();
            // 获取“选课操作-选课”对应链接
            await page.frames().find(frame => frame.name() == 'tree')!
                .waitForXPath('//*[@id="show"]/li[2]/a')
                .then(xk => xk!.getProperty('href'))
                .then(prop => prop!.jsonValue())
                .then(href => page.goto(href as string));
            // // 进入只显示候选课程列表的页面
            // await page.waitForXPath('//*[@id="iframe1"]')
            //     .then(iframe => iframe!.getProperty('src'))
            //     .then(prop => prop!.jsonValue())
            //     .then(src => page.goto(src as string));
            const coursesFrame = await page.frames().find(frame => frame.name() == 'fcxkFrm')!;

            console.log(conf.courses, success);
            while (success.length < conf.courses.length) {
                for (let course of conf.courses) {
                    if (success.includes(course)) continue;
                    logger.info(`尝试提交课程：${course}`);
                    await new Promise(async resolve => {
                        // 首先注册提交后对话框处理逻辑
                        page.once('dialog', async dialog => {
                            const msg = dialog.message();
                            logger.info(`${course} 提交信息：${msg}`);
                            if (msg == '提交选课成功;') {
                                success.push(course);
                                logger.info(`${course} 选课成功`);
                            } else {
                                logger.info(`${course} 提交失败`);
                            }
                            resolve(await dialog.accept());
                        });

                        // 处理提交后出现的异常情况（主要是登录掉线）。FIXME: 尚未测试
                        page.once('response', res => { if (res.status() != 200) throw new Error('状态异常，重新登录') });
                        // 选择课程
                        await coursesFrame.waitForXPath(`//*[@value="${course}"]`).then(x => x!.click());
                        await coursesFrame.waitForXPath('//*[@id="a"]/div/div/div[2]/div[2]/input').then(x => x!.click());
                        logger.info('点击提交');
                    });
                    await delay(1000);
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
