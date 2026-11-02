/**
 * 统一配置：所有路径都从这里来，方便移植到任何机器。
 * 用环境变量覆盖即可，不写死任何人的家目录。
 */
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.MEMBRAIN_HOME || path.join(os.homedir(), '.membrain');
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** 会话日志目录（用来增量转录成记忆） */
export const SESSIONS_DIR = process.env.DSH_SESSIONS || path.join(DSH_HOME, 'sessions');
/** 技能目录（SKILL.md 扫描） */
export const SKILLS_DIR = process.env.DSH_SKILLS || path.join(DSH_HOME, 'skills');
/** 凭证文件（只放路径，不放内容） */
export const CRED_FILE = process.env.MEMBRAIN_CRED || path.join(DSH_HOME, '.credentials.yaml');
/** 字条（常驻注入的那份） */
export const NOTE_FILE = process.env.MEMBRAIN_NOTE || path.join(DSH_HOME, 'memory', 'MEMORY.md');
/** 手机桥接头文件（可选，用于通知） */
export const BRIDGE_HEADERS = process.env.DSH_BRIDGE_HEADERS || path.join(DSH_HOME, '.bridge_headers');
/** LLM 配置 */
export const LLM = {
  baseURL: process.env.MEMBRAIN_LLM_BASE || 'https://api.deepseek.com/v1',
  apiKeyEnv: process.env.MEMBRAIN_LLM_KEY_ENV || 'DEEPSEEK_API_KEY',
  model: process.env.MEMBRAIN_LLM_MODEL || 'deepseek-chat',
};
