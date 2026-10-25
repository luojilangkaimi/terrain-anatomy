# 地形解剖师 · 交给 Claude 的说明

> 云南大学 TRAE 校园 AI 创意实践挑战赛 S9「AI × 地球科学」赛道，题三「地形解剖师」参赛作品。
> 纯静态站点，无构建步骤、无网络依赖，断网可跑。当前 2D 与 3D 全流程已跑通，需要的是**视觉与交互打磨**，不是重写。

---

## 1. 怎么跑

```bash
cd app
python -m http.server 8765
# 打开 http://127.0.0.1:8765/
```

不能双击 `file://`：浏览器禁止本地页面 `fetch` 读 `data/*.bin`。

---

## 2. 文件结构

```
app/
├─ index.html          外壳：顶栏、左工具栏、右信息栏、二维舞台、三维容器
├─ view3d.html         三维独立页（降级用，主页面不依赖）
├─ css/app.css         全部样式
├─ js/
│  ├─ palette.js       共用色带（2D/3D 必须同一套，见 §4.3）
│  ├─ loader.js        读 dem.bin / meta.json / stats.json
│  ├─ render2d.js       Canvas 2D：逐像素底图 + 视图变换 + overlay + 剖面线
│  ├─ terrain.js       坡度/坡向（Horn 3×3）、剖面
│  ├─ hydro.js         填洼（Priority-Flood+ε）、D8、汇流、河网、流域
│  ├─ orbit.js         轨道相机
│  ├─ render3d.js      three.js 三维地形
│  └─ ui.js            交互、自检、2D/3D 集成（唯一允许操作 DOM 的文件）
├─ data/aoi1/          1260×1080，30 m，云大后山
└─ data/aoi2/          1800×1440，90 m，三江并流
lib/three.min.js       three.js r150（deprecated build，控制台有一条弃用警告，正常）
```

**给 Claude 的代码包里没有 `dem.bin`（共 15 MB）和 `three.min.js`（599 KB）**，这两个在完整包里。看代码不需要它们。

---

## 3. 已冻结的契约（改代码可以，改这些不行）

### 3.1 数据格式

```
dem.bin    Float32 小端，行优先，左上角起，长度 = w×h
meta.json  {name,width,height,x0,y0,dx_deg,dy_deg,dx_m,dy_m,cell_area_m2,crs,elev:{min,mean,max},source}
stats.json {slope_bins_deg, slope_hist_pct, slope_mean_deg, slope_method}   参考值，用于自检
```

### 3.2 模块接口

```js
Terrain.slopeAspect(z,w,h,dx_m,dy_m) -> {slope, aspect}      // 度；坡向正北 0、顺时针，平坦 -1
Terrain.profile(z,w,h,x0,y0,x1,y1)   -> {pts:[{d_km,z}], len_km}
Hydro.computeHydro(z,w,h)            -> {filled, dir, acc}
Hydro.riverMask(acc,w,h,thr)         -> Uint8Array            // thr = 上游格数
Hydro.watershed(dir,w,h,ix,iy)       -> {mask, area_km2, outlet:[ix,iy]}
Render3D.mount3D(el,{z,meta,ve,onPick}) / setVE / setView / spin / setOverlay / clearOverlay / screenshot / info
```

### 3.3 D8 方向编码（硬约定，动一位全盘错）

```
0 东(0,+1)  1 东南(+1,+1)  2 南(+1,0)  3 西南(+1,-1)
4 西(0,-1)  5 西北(-1,-1)  6 北(-1,0)  7 东北(-1,+1)  -1 出口
dr 为正 = 向南（行号增大）
```

### 3.4 分析栅格 ≠ 渲染栅格

查询、坡度、剖面、流域一律用 `dem.bin` 原生值，最近邻采样；美化只能作用在另一张显示缓冲上。
剖面要求「与 DEM 像素值抽查 10 点一致」，任何平滑都会扣分。

---

## 4. 已验证的数字（优化后必须仍然成立）

| 指标 | AOI1 | AOI2 |
|---|---|---|
| 坡度均值 | 10.55° | 26.24° |
| 与参考逐箱最大差 | 0.00 pp | 0.01 pp |
| 上坡流向 / 越界 | 0 / 0 | 0 / 0 |
| 高程 min/mean/max | 1779 / 2027 / 2519 m | 798 / 3030 / 5058 m |

- 三维：512×439 网格、225,720 顶点、构建 261 ms、环绕 61 fps、`paletteFrom = palette.js RAMP_HEX`
- 右侧「一键自检」必须全 PASS；控制台除 three.js 弃用警告外应无报错

---

## 5. 可以优化什么（按性价比排序）

1. **视觉层级**：目前是深色工具风，偏「GIS 软件」。可做成有主视觉的展台：顶栏品牌区、图层按钮的图标化、信息栏的分组留白、导出图的落款。
2. **首屏观感**：加载态、切 AOI 的过渡、图层切换的淡入，现在都是硬切。
3. **导出图**：PNG 只有地图，缺标题、比例尺、数据来源、垂直夸大角标、审图号位。
4. **三维控件**：顶栏按钮是文字，可做成图标 + tooltip；夸大滑杆加刻度。
5. **移动端**：当前只保证桌面 1280×800，窄屏会挤。
6. **可访问性**：按钮缺 `aria-*`，键盘只覆盖了部分操作。

## 6. 不要做什么

- 不要改成需要构建的工程（Vite/React/npm），现场要能直接开。
- 不要引入任何网络请求（CDN、字体、图标库），必须断网可跑。
- 不要动 `dem.bin` / `meta.json` 格式与 §3.3 的 D8 编码。
- 不要把坡度计算搬到 GPU 或做平滑；不要把分析结果换成降采样版本。
- 不要删「一键自检」面板，它是验收锚点的现场证据。
- 不要合并 `render2d.js` 和 `render3d.js`，两者生命周期不同。

## 7. 现场约束

- 演示时长 90 秒，评委看的是：出图快、能对真值、能划流域、三维能转能调、能导出。
- 交互坑：二维点选要求按下后位移 ≤ 4 px，否则判为平移；演示时不要拖。
- 改完任何 JS 必须 `Ctrl+Shift+R`，普通刷新会命中旧缓存（脚本已带 `?v=1`，仍建议硬刷新）。

---

## 8. 数据来源（导出图与答辩要写）

- 地形：Copernicus DEM GLO-30 / GLO-90，SRTM 90 m（AOI2 缺块已用 SRTM 补齐）
- 投影：EPSG:4326，坡度按纬度校正的像元尺寸计算
- 底图：不使用在线底图；如后续加行政区划，须用自然资源部标准地图并标注审图号
- 结论仅限「基于公开数据的演示性分析」，不构成官方监测评价
