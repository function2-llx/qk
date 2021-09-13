import fs from 'fs'
import path from 'path'
import { URL, URLSearchParams } from 'url'
import readline from 'readline'

import puppeteer, { Page } from 'puppeteer'
import { FateaDM } from 'fateadm'
import yaml from 'js-yaml'

// import './aug'

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

puppeteer.launch({
    // headless: false,
    args: [
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
    ],
}).then(async browser => {
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
                // const code = result.Result.toUpperCase();
                const code: string = await new Promise(resolve => rl.question('manual code: ', answer => resolve(answer.toUpperCase())));
                console.log('code is', code);
    
                const authUrl = new URL('https://zhjwxk.cic.tsinghua.edu.cn/j_acegi_formlogin_xsxk.do');
                authUrl.search = new URLSearchParams({
                    j_username: conf.auth.username,
                    j_password: conf.auth.password,
                    captchaflag: 'login1',
                    _login_image_: code,
                }).toString();
                // console.log(authUrl);
                await page.goto(authUrl.toString());
                if (page.url() == MAIN_URL) {
                    fs.writeFileSync(path.join(resultsFolder, `${code}.jpg`), buffer);
                    break;
                }
            }
        }
        return page;
    }
    const page = await login();
    await page.frames().find(frame => frame.name() == 'tree')!
        .waitForXPath('//*[@id="show"]/li[2]/a')
        .then(xk => xk!.getProperty('href'))
        .then(prop => prop!.jsonValue())
        .then(href => page.goto(href as string));
    await page.waitForXPath('//*[@id="iframe1"]')
        .then(iframe => iframe!.getProperty('src'))
        .then(prop => prop!.jsonValue())
        .then(src => page.goto(src as string));
    
    // page.waitForSelector('input');
    for (const course of conf.courses) {
        await page.waitForSelector(`input[value="${course}"]`).then(x => x!.click());
    }
    await page.screenshot({ path: 'screenshot-233.png' });
    browser.close();
    rl.close();
});
