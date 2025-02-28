const { App } = require("@slack/bolt");
const OpenAI = require("openai");
const schedule = require("node-schedule");

require("dotenv").config();

// 한국 시간대 설정
process.env.TZ = "Asia/Seoul";

// 사용자 프로필 및 운세 캐싱
const userProfileCache = new Map(); // { userId: profile }
const horoscopeCache = new Map(); // { "userId:YYYY-MM-DD": horoscope }
const sentMessagesToday = new Set(); // 메시지 발송 캐시

// Slack App 설정
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3000,
});

// OpenAI 클라이언트 초기화
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 사용자 프로필 가져오기 함수
async function getUserProfile(userId, client) {
  if (userProfileCache.has(userId)) {
    return userProfileCache.get(userId);
  }

  try {
    const { profile } = await client.users.profile.get({ user: userId });

    console.log(
      `\n1️⃣ ${profile.real_name} / ${JSON.stringify(profile.fields, null, 2)}`
    );
    console.log("Fetched user profile:", JSON.stringify(profile, null, 2));

    userProfileCache.set(userId, profile); // 캐싱

    return profile;
  } catch (error) {
    console.error("Error fetching user profile:", error);
    return null;
  }
}

// OpenAI API로 운세 가져오기 함수
async function getHoroscope(userId, birthdate) {
  const today = new Date();
  const formattedDate = `${today.getFullYear()}-${
    today.getMonth() + 1
  }-${today.getDate()}`;
  const cacheKey = `${userId}:${formattedDate}`;

  if (horoscopeCache.has(cacheKey)) {
    console.log(`Cache hit for horoscope: ${cacheKey}`);
    return horoscopeCache.get(cacheKey);
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `너는 '운세를 보는 점쟁이'야.
            특히 사람들의 생년월일을 기반으로 오늘의 운세를 봐주는 전문가야.
            너의 역할은 직장인을 위한 친절하고 긍정적인 오늘의 운세를 다섯 문장으로 제공하는 거야.
            운세는 아침에 직장 동료에게 보내는 내용처럼 작성해.
            첫 문장에서는 인사를 생략하고 바로 운세를 시작해야 해.
            마지막 문장에는 부드러운 어조를 위해 내용과 어울리는 이모티콘 2개를 추가해.
            별자리에 대한 언급은 하지 마.
            그리고 요일에 대한 언급도 하지 마.`,
        },
        {
          role: "user",
          content: `오늘 날짜는 ${formattedDate}입니다.
            사용자 생년월일은 ${birthdate}입니다.
            직장인을 위한 친절하고 긍정적인 운세를 알려줘.`,
        },
      ],
      max_tokens: 300,
    });

    let horoscope = response.choices[0].message.content.trim();
    horoscopeCache.set(cacheKey, horoscope);
    console.log(`2️⃣ ${horoscope}\n(${new Date()})\n`);
    return horoscope;
  } catch (error) {
    console.error("Error fetching horoscope from OpenAI:", error);
    return null;
  }
}

// 운세 메시지 발송 함수
async function sendDailyHoroscopeToUser(userId, client) {
  const userProfile = await getUserProfile(userId, client);

  // 생일 확인 및 필터링
  const fields = userProfile?.fields || {};

  const birthdate = fields[BIRTHDATE_FIELD_KEY]?.value || null;

  // 생년월일 미입력시 메시지 발송 안함
  if (!birthdate) {
    return;
  }

  // 예외 처리 사용자 명단
  if (EXCEPTION_USER_LIST.includes(userProfile.real_name)) {
    return;
  }

  const horoscope = await getHoroscope(userId, birthdate);

  if (horoscope) {
    const formattedHoroscope = horoscope
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    await client.chat.postMessage({
      channel: userId,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<@${userId}>님, 오늘의 운세를 알려드립니다 🧙🪄*\n\n`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔮 *오늘의 운세:*\n${formattedHoroscope}`,
          },
        },
        {
          type: "divider",
        },
      ],
      text: "오늘의 운세를 알려드립니다!",
    });
  } else {
    await client.chat.postMessage({
      channel: userId,
      text: "운세를 가져오지 못했습니다. 다시 시도해주세요.",
    });
  }
}

// 모든 사용자 가져오기 함수 (페이지네이션 포함)
async function getAllUsers(client) {
  let users = [];
  let cursor = undefined;

  do {
    const result = await client.users.list({
      cursor: cursor,
      limit: 500,
    });

    if (result.members) {
      users = users.concat(
        result.members.filter(({ is_bot, deleted }) => !is_bot && !deleted)
      );
    }

    cursor = result.response_metadata && result.response_metadata.next_cursor;
  } while (cursor);

  return users;
}

// 정식 스케줄링 (매주 월요일부터 금요일 특정 시간)
function scheduleDailyMessage() {
  schedule.scheduleJob(
    { hour: 10, minute: 30, dayOfWeek: new schedule.Range(1, 5) },
    async () => {
      try {
        const users = await getAllUsers(app.client);

        const today = new Date();
        const todayStr = `${today.getFullYear()}-${
          today.getMonth() + 1
        }-${today.getDate()}`;

        if (!sentMessagesToday.has(todayStr)) {
          sentMessagesToday.clear();
          sentMessagesToday.add(todayStr);
        }

        for (const user of users) {
          const cacheKey = `${user.id}:${todayStr}`;

          if (!sentMessagesToday.has(cacheKey)) {
            await sendDailyHoroscopeToUser(user.id, app.client);
            sentMessagesToday.add(cacheKey);
          }
        }

        console.log(`⭕️ (${new Date()}) 자동 메시지 발송 완료 ⭕️`);
      } catch (error) {
        console.error(`❌❌❌ (${new Date()}) 자동 메시지 발송 실패: ${error}`);
      }
    }
  );
}

// Slack Bolt 앱 시작
(async () => {
  try {
    console.log("Starting Slack Bolt app...");
    await app.start();
    console.log("⚡️ Bolt app is running!");

    // 실제 스케줄링
    scheduleDailyMessage();
  } catch (error) {
    console.error("Unable to start app:", error);
  }
})();
