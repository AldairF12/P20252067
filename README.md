# 🔐 S.A.P.O. — Personal Data Privacy Protection System

> Browser extension based on Natural Language Processing (NLP) designed to detect potential exposure of personal data in online environments.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-brightgreen)](https://chromewebstore.google.com/detail/detector-de-exposici%C3%B3n-de/lbomkfpljikaahhjcjebooledclfljib)

---

## 📌 Overview

**S.A.P.O. (Sistema de Alerta y Protección de la Privacidad Online)** is a browser-based privacy protection solution developed to help users identify potential exposure of personal information while interacting with online platforms.

The project combines **Natural Language Processing, Machine Learning and browser extension technologies** to analyze user-entered text and identify potential personal data exposure.

The solution was developed as part of a research project focused on personal data protection in online environments.

---

## 🎯 Problem

Users may unintentionally share personal information while interacting with online platforms such as gaming and communication services.

Examples include:

- Email addresses
- Names
- Identification numbers
- Payment information
- Other potentially sensitive personal information

S.A.P.O. aims to provide an additional layer of privacy awareness by detecting potential exposure before the information is shared.

---

## 💡 Solution

The system analyzes text entered by the user and identifies potential personal data using a Natural Language Processing model.

When potentially sensitive information is detected, the extension provides a privacy alert to the user.

The system was designed with a **privacy-first approach**, prioritizing local processing whenever possible.

---

## ✨ Main Features

- 🔎 Personal data exposure detection
- 🔐 Privacy alerts
- 🧠 NLP-based detection
- 🤖 DistilBERT model
- 🌐 Chrome Extension
- ⚡ Local processing
- 🛡️ Privacy-focused architecture
- 📊 Detection of different types of personal information
- 🎮 Support for selected online platforms

---

## 🏗️ Architecture

```text
┌──────────────────────┐
│      User Input      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Chrome Extension   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Text Preprocessing   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│     NLP Model        │
│     DistilBERT       │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Personal Data        │
│ Detection            │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│    Privacy Alert     │
└──────────────────────┘
