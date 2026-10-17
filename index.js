/**
 * 互动小说增强系统 / Interactive Fiction Enhancer
 * TauriTavern / SillyTavern 扩展入口。
 *
 * SillyTavern 以 <script type="module"> 加载 manifest.js 指向的文件，
 * 因此这里可以直接使用 ES module 语法与相对路径导入。
 */
import { boot } from './src/main.js';

boot();
