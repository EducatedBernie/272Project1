# Datasets for benchmarking math equation extraction from lecture videos

**No single public dataset currently combines lecture video, audio, and LaTeX ground truth with timestamps** — the exact combination needed to benchmark a system that watches STEM lectures and extracts equations. However, a rich ecosystem of partial-overlap datasets exists across handwritten math recognition, image-to-LaTeX conversion, spoken math transcription, and lecture video analysis. The most promising strategy is to assemble a composite benchmark from multiple datasets, each covering a different modality of your pipeline. This report catalogs **30+ datasets** across these categories, ranked by relevance to your use case.

---

## The critical gap: no unified lecture-video-to-LaTeX benchmark exists

The field's most glaring absence is a dataset that annotates equations in lecture videos with both visual and temporal LaTeX ground truth. AccessMath (12 whiteboard lecture videos from RIT) provides timestamped bounding boxes for handwritten content but **no LaTeX transcriptions**. Video-MMLU (1,065 math lecture videos, ICCV 2025 Workshop) tests comprehension of equations in video but targets QA accuracy, not extraction fidelity. An ICLR 2026 paper explicitly calls out this gap, noting existing math benchmarks use only static images and lack "temporally extended contexts with dynamically evolving visual content."

Your best path forward is a **modular benchmark** combining speech-to-LaTeX datasets (MathSpeech, S2L), handwritten math recognition datasets (CROHME, HME100K, MathWriting), and image-to-LaTeX datasets (im2latex, UniMER). Each tests a distinct pipeline stage. Below, datasets are organized by relevance tier and modality.

---

## Tier 1: Directly relevant datasets for your pipeline

These datasets most closely match your task of extracting LaTeX from lecture video content — covering spoken math, handwritten math on boards, or multimodal combinations.

### MathSpeech (AAAI 2025) — speech-to-LaTeX baseline

Confirms what you already have. **1,101 audio samples** from 89 real YouTube math lectures, each pairing a ~5-second spoken equation clip with ground-truth LaTeX. Published by Hyeon et al. as a benchmark for ASR-to-LaTeX pipelines. The dataset is test-only — the ~8M TTS-synthesized training samples are not released. Annotations derive from what lecturers *say*, not what they *write*, causing notation errors (e.g., "side" transcribed instead of "sine," wrong bracket styles). English only. Download at [HuggingFace: AAAI2025/MathSpeech](https://huggingface.co/datasets/AAAI2025/MathSpeech). **Relevance: high for speech branch; limited for visual branch.**

### Speech-to-LaTeX (S2L) dataset (ICLR 2026) — the strongest new spoken-math resource

The first large-scale, fully open-source spoken-math dataset, published by Korzh et al. Contains **S2L-equations** (~10,700 distinct isolated equations, each spoken by up to 3 of 33 annotators) and **S2L-sentences** (~12,000 mathematical sentences with equations in context), plus **~571K TTS-augmented samples**. Human-annotated audio covers English and Russian, drawn from Proof-Pile, MathBridge, and TexTeller sources. This dataset is **~60× larger** than MathSpeech for human-annotated spoken equations. Available via OpenReview: [openreview.net/forum?id=gk8WMxzIQP](https://openreview.net/forum?id=gk8WMxzIQP). **Relevance: very high for speech-to-LaTeX benchmarking.**

### HAMEX — the only multimodal handwriting+audio math dataset

A unique 2011 dataset pairing **4,350 online handwritten math expressions** (InkML with symbol segmentation and MathML ground truth) with **corresponding audio recordings** of the same expressions. Written and spoken by 58 participants. The critical limitation: **audio is in French only**. Available via [hal.science/hal-00615210](https://hal.science/hal-00615210). Despite its age and language restriction, HAMEX remains the only public dataset that pairs handwritten math strokes with spoken audio for the same expressions. **Relevance: moderate-high (multimodal, but French audio limits utility).**

### MathBridge — massive text-pair corpus for spoken-to-LaTeX mapping

**23.2 million pairs** of LaTeX formulas with corresponding spoken English descriptions, extracted from arXiv papers and open-source textbooks. Text-only (no actual audio) — the "spoken" descriptions are LLM-generated (GPT-3.5). Fields include context_before, equation, context_after, and spoken_English. Download: [HuggingFace: Kyudan/MathBridge](https://huggingface.co/datasets/Kyudan/MathBridge). Known quality issues: invalid LaTeX, missing pronunciations, duplicates, very short average descriptions (**5.79 tokens**). **Relevance: high for training speech-to-LaTeX mapping; not suitable as ground truth due to quality issues.**

### AccessMath — whiteboard lecture videos with temporal annotations

**12 linear algebra lecture videos** (average ~49 minutes each, 1920×1080) with timestamped bounding-box annotations for handwritten whiteboard content. Annotations mark when content is written and erased, with binary keyframes. Expanded by the LectureMath/FCN-LectureNet project to 17+ videos including chalkboard content. **No LaTeX ground truth** — only bounding boxes and binary connected components. Download: [github.com/bhargavaurala/accessmath-icfhr2018](https://github.com/bhargavaurala/accessmath-icfhr2018). **Relevance: high for visual detection/segmentation stage; you would need to add LaTeX annotations yourself.**

### Video-MMLU (ICCV 2025 Workshop) — lecture video understanding benchmark

**1,065 multi-discipline lecture videos** (90.3% math, 3.6% physics, 6.1% chemistry) with 15,746 QA pairs and 1,065 detailed captions. Tests models on dynamic OCR of equations in lecture videos. Evaluated 96 models; accuracy ranged **10–50%**, with Claude-3.5-Sonnet performing best. Download: [HuggingFace: Enxin/Video-MMLU](https://huggingface.co/datasets/Enxin/Video-MMLU). This is the closest existing benchmark to lecture-specific math extraction, though it measures *comprehension* (QA) rather than *extraction accuracy* (LaTeX fidelity). **Relevance: high for end-to-end evaluation of lecture understanding.**

---

## Tier 2: Handwritten math expression recognition datasets

These benchmark the visual recognition component of your pipeline — converting images of handwritten equations (as seen on boards) into LaTeX.

### CROHME — the standard handwritten math benchmark (2011–2023)

The most widely cited benchmark in the field, with seven competition editions at ICDAR/ICFHR. The standard setup uses **8,836 training expressions** and three test sets: **986** (2014), **1,147** (2016), **1,199** (2019). The 2023 edition added **3,905 new bimodal samples** (both online ink and offline images) collected across France, Japan, and Sweden, with a new **2,300-expression test set**. Format is InkML (stroke data) with MathML and LaTeX ground truth, covering **101 symbol classes**. CROHME 2023 also incorporated OffRaSHME scanned-paper data for the first time.

| Version | Training | Test | Key Addition |
|---------|----------|------|-------------|
| 2014 | 8,836 | 986 | Isolated symbols, matrices |
| 2016 | 8,836 | 1,147 | 500K Wikipedia LaTeX formulas |
| 2019 | 8,836 + prev. tests | 1,199 | First offline (rendered) images |
| 2023 | ~10,979 + prev. + synthetic | 2,300 | Bimodal (ink + scanned images) |

**Download:** CROHME 2023 at [zenodo.org/records/8428035](https://zenodo.org/records/8428035); earlier versions at TC11 repositories. **Limitations:** Relatively small, 101 symbol classes only, writers copy printed expressions (not spontaneous), CC BY-NC-SA 3.0 license. **Relevance: high — the de facto standard for handwritten math recognition evaluation.**

### HME100K — large-scale real-world handwritten math

The largest real-scene handwritten math dataset: **74,502 training + 24,607 test images** photographed from paper across tens of thousands of writers. Contains **249 symbol classes** with Easy/Medium/Hard subsets. Unlike CROHME's clean digital strokes, HME100K includes real-world challenges: **color variation, blur, complex backgrounds, twisted images** — much closer to what a camera pointed at a chalkboard would see. LaTeX ground truth provided as text labels. Download: [ai.100tal.com/dataset](https://ai.100tal.com/dataset) and [github.com/Phymond/HME100K](https://github.com/Phymond/HME100K). **Relevance: very high — the closest existing dataset to real chalkboard/whiteboard conditions.**

### MathWriting (Google Research, 2024) — largest online handwritten math dataset

**253,000 human-written expressions + 396,000 synthetic** ones, making it the largest handwritten math dataset overall (**~649K total**). Collected via Android app from ~150 device types. InkML format with both raw and normalized LaTeX ground truth, **254 token classes** including matrices. Published at KDD 2025. Download: [github.com/google-research/google-research/tree/master/mathwriting](https://github.com/google-research/google-research/tree/master/mathwriting); rendered images at [HuggingFace: deepcopy/MathWriting-human](https://huggingface.co/datasets/deepcopy/MathWriting-human). **Ground truth error rate estimated at 1–2%.** CC BY-NC-SA 4.0 license. **Relevance: high for training and evaluating handwritten recognition models.**

---

## Tier 3: Image-to-LaTeX datasets for printed and typeset math

These are useful for the OCR component when equations appear in slides, textbook overlays, or printed notes within lectures.

### im2latex family — the foundational image-to-LaTeX benchmarks

The original **im2latex-100k** (Deng et al., 2017) contains **~103,558 formula images** rendered from arXiv LaTeX source using pdfLaTeX in Computer Modern font. Ground truth is perfect (images rendered from the LaTeX). Three successors address its limitations:

- **im2latex-230k**: Expanded to ~230K formulas, 72 DPI, 579-token vocabulary. Download: [zenodo.org/records/7738969](https://zenodo.org/records/7738969)
- **im2latexv2** (MathNet, 2024): Same ~100K formulas rendered in **30 fonts** (training) and **59 fonts** (test) at 600 DPI with normalized LaTeX. Download: [zenodo.org/records/11230382](https://zenodo.org/records/11230382)
- **realFormula** (MathNet, 2024): Real-world test set extracted from actual arXiv PDFs (not re-rendered). Download: [zenodo.org/records/11296815](https://zenodo.org/records/11296815)

Original download: [zenodo.org/records/56198](https://zenodo.org/records/56198); also on [HuggingFace](https://huggingface.co/datasets/yuntian-deng/im2latex-100k) and [Kaggle](https://www.kaggle.com/datasets/shahrukhkhan/im2latex100k). **Relevance: moderate — useful for printed math OCR but single-font/synthetic limitations reduce applicability to lecture settings.**

### UniMER-1M and UniMER-Test — unified real-world math recognition

The first dataset unifying all real-world math recognition scenarios. **UniMER-1M** (1M+ training pairs) combines printed, handwritten, and screen-captured math. **UniMER-Test** covers four categories: Simple Printed (SPE), Complex Printed (CPE), Screen-Captured (SCE), and Handwritten (HWE). The team also introduced **CDM (Character Detection Matching)**, accepted at CVPR 2025, as a fairer metric than BLEU/edit distance for formula recognition. Download: [HuggingFace: wanderkid/UniMER_Dataset](https://huggingface.co/datasets/wanderkid/UniMER_Dataset); code: [github.com/opendatalab/UniMERNet](https://github.com/opendatalab/UniMERNet). **Relevance: high — the SCE and HWE categories directly test noisy, real-world equation images.**

### IBEM — document-scale equation detection and recognition

**600 scientific documents** containing **29,593 displayed** and **136,635 inline** mathematical expressions (160K+ total), each with page-level position and LaTeX transcription. Ground truth extracted from LaTeX source. CC-BY license. Download: [zenodo.org/records/4757865](https://zenodo.org/records/4757865). **Relevance: moderate — useful for printed equation recognition at scale.**

### Other large-scale printed datasets

- **OleehyO/latex-formulas**: ~550K cleaned image-LaTeX pairs from arXiv. [HuggingFace](https://huggingface.co/datasets/OleehyO/latex-formulas)
- **MER-17M / CMER-Bench** (Dec 2025): **17.7M image-LaTeX pairs** from arXiv — the largest MER dataset. CMER-Bench tests Easy/Moderate/Complex tiers. Existing models score only **55.7% BLEU on complex expressions**. Paper: arXiv:2512.13731
- **TexTeller 3.0 data**: **80M image-formula pairs** — largest training corpus. [github.com/OleehyO/TexTeller](https://github.com/OleehyO/TexTeller)

---

## Tier 4: Formula detection and document parsing benchmarks

These test the ability to *locate* equations in images/documents — a prerequisite for recognition.

| Dataset | Contents | Size | LaTeX GT? | Download |
|---------|----------|------|-----------|----------|
| **TFD-ICDAR2019v2** | Typeset formula bounding boxes in scanned math articles | 805 pages, 38K formulas | No (detection only) | [github.com/MaliParag/TFD-ICDAR2019](https://github.com/MaliParag/TFD-ICDAR2019) |
| **InftyMCCDB-2** | Scanned printed math from journal articles | 19,381 expressions, 213 classes | Symbol-level label graphs | [zenodo.org/records/3483048](https://zenodo.org/records/3483048) |
| **OmniDocBench** (CVPR 2025) | Diverse PDF parsing including formula recognition | Multi-task | Yes (formulas) | [github.com/opendatalab/OmniDocBench](https://github.com/opendatalab/OmniDocBench) |
| **olmOCR-Bench** | 1,403 PDFs with 7,010 unit tests including arXiv math and old scanned textbooks | 7K test cases | Yes (via KaTeX rendering comparison) | [github.com/allenai/olmocr](https://github.com/allenai/olmocr) |
| **OCRBench v2** | 29 OCR-related datasets including HMER | Multi-task | Varies | [github.com/Yuliang-Liu/MultimodalOCR](https://github.com/Yuliang-Liu/MultimodalOCR) |

---

## Tier 5: Symbol-level and supplementary datasets

These are less directly relevant but can support specific pipeline components.

**Detexify training data** (~342K individual symbol drawings, 1,077 LaTeX symbol classes) available at [github.com/kirel/detexify-data](https://github.com/kirel/detexify-data). **HASYv2** provides 168K symbol images across 369 classes at 32×32 resolution, available on [Kaggle](https://www.kaggle.com/datasets/guru001/hasyv2). **Aida Calculus** offers 100K synthetic handwritten calculus expressions on [Kaggle](https://www.kaggle.com/datasets/aidapearson/ocr-data). The **Kaggle Handwritten Math Symbols** dataset has 100K+ JPEG images of 82 symbol classes extracted from CROHME. These are useful for symbol-level classifier pre-training but not directly for full expression benchmarking.

---

## What recent systems benchmark against and which metrics they use

The 2024 survey by Truong et al. in *Pattern Recognition* confirms the standard evaluation stack: virtually all recent handwritten math recognition models (BTTR, CoMER, CAN, ABM, SAN, TAMER, ICAL) benchmark on **CROHME 2014/2016/2019 + HME100K**, reporting **Expression Recognition Rate (ExpRate)** — the percentage of expressions with exactly correct LaTeX. Progress has been slow: only **~3% improvement** from CoMER (2022) to current SOTA on CROHME, suggesting the benchmark may be near saturation.

For printed math, **im2latex-100k** remains standard, with **BLEU** and **edit distance** as primary metrics. The UniMERNet team argues both are flawed and proposes **CDM (Character Detection Matching)**, which renders predicted and ground-truth LaTeX, then compares character-level bounding boxes — a more visually faithful metric accepted at CVPR 2025.

For document-scale systems, **Nougat** (Meta, 2023) trained on **8M+ arXiv articles** and evaluates with edit distance, BLEU, METEOR, and F-measure. **olmOCR 2** (Allen AI, 2025) introduces unit-test-style evaluation where LaTeX is rendered via KaTeX and compared by symbol bounding box positions — scoring **82.4** on its benchmark.

---

## Recommended composite benchmark strategy

Since no single dataset covers your full pipeline, here is a practical approach to assembling a benchmark:

- **Speech branch**: Use **S2L** (ICLR 2026) for spoken-equation-to-LaTeX and **MathSpeech** for real-lecture conditions. Together these provide ~12K human-spoken equations with ground truth.
- **Visual branch (handwritten)**: Use **HME100K** for realistic camera-captured handwritten math and **CROHME 2019/2023** for the standard benchmark. Consider **MathWriting** for scale.
- **Visual branch (printed/slides)**: Use **UniMER-Test** (especially the SCE screen-captured category) and **im2latexv2** with the **realFormula** test set.
- **End-to-end video understanding**: Use **Video-MMLU** for lecture-level evaluation and **AccessMath** for temporal detection.
- **Metric**: Adopt **CDM** (CVPR 2025) over BLEU/edit distance for fairer formula comparison, supplemented by ExpRate for exact-match evaluation.

The highest-impact contribution you could make would be to annotate a subset of AccessMath or similar lecture videos with equation-level LaTeX ground truth and timestamps — this would fill the field's most significant gap and create the first true lecture-video-to-LaTeX benchmark.