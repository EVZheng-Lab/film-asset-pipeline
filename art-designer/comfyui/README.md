# ComfyUI 工作流

| 文件 | 是什么 | 怎么用 |
|---|---|---|
| `h3_t2i.api.json` | 文生图工作流（API 格式） | `scripts/render-comfyui.mjs` 出文生图时读的就是它 |
| `h3_edit.api.json` | 编辑工作流（API 格式，一张参考图；多张时脚本会照样加 `LoadImage` 节点） | 出编辑图时读的就是它 |
| `official_t2i.json` | 官方文生图模板（界面格式，原样） | 想在 ComfyUI 界面里手动出图时拖进去 |
| `official_edit.json` | 官方编辑模板（界面格式，原样） | 同上；手动用时按下面改两处 |

两个 API 文件跟官方模板是同一套节点和参数：6 步 / CFG 1 / euler / simple，没有负面提示词。
脚本只改提示词、尺寸、种子、模型文件名和参考图，别的不动。在 ComfyUI 里打开 API 格式的文件也能直接跑。

## 跟官方编辑模板的两处不同

1. **输出尺寸不跟参考图走。** 官方模板把参考图缩放到约 4MP，再用缩放后的尺寸当输出尺寸，所以编辑出来是 4MP。
   我们参考图同样缩到约 4MP，输出单独设成约 9MP（16:9 4000x2240，3:4 2592x3456，4:3 3456x2592，1:1 3008x3008，21:9 4576x1952）。
   实测 9MP 比 4MP 清楚，16MP 会出噪点、编辑改不上去。手动用官方模板时，把 `MiniMaxH3ImageConditioning` 的宽高从
   `GetImageSize` 断开，填上面的数字。
2. **文本编码器**：官方模板用 `qwen3vl_32b_minimax_h3_int8_convrot`，作者跑图机上装的是同一模型的 `nvfp4_awq` 版。
   脚本默认用官方文件名，装的不一样就加 `--clip <文件名>`。

## 模型

不用手动下：`scripts/h3-env.mjs check` 查环境，`setup` 装便携版 ComfyUI 和下面三个模型（国内从 ModelScope 下）。
手动下的话，放进 ComfyUI 对应目录（ComfyUI 要 v0.45.0 以上才有 H3-Image 节点）。HuggingFace 下不动就换 ModelScope 同名仓库：`https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3-Image/resolve/master/<目录>/<文件名>`：

- `models/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors` —— [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)
- `models/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` —— [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)
- `models/vae/minimax_h3_image_vae_fp16.safetensors` —— [Comfy-Org/MiniMax-H3-Image](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)

官方模板来自 [Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates)（MIT 许可）。
作者的跑图机是一张 RTX 4080 16GB：16MP 文生图约 95 秒一张，9MP 编辑约 100 秒一张。
