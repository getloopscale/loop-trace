# PRD — Theo Lens

## Overview

Theo Lens é uma plataforma open source de observabilidade para agentes de IA.

Ela permite que equipes entendam exatamente o que aconteceu durante uma execução, reproduzam comportamentos, identifiquem falhas, analisem ferramentas utilizadas e monitorem custos operacionais.

Theo Lens é para agentes de IA o que Jaeger é para microsserviços.

---

# Vision

Tornar agentes de IA observáveis em produção.

Toda execução deve ser:

* rastreável
* reproduzível
* debuggável
* mensurável

---

# Problem Statement

Equipes que operam agentes de IA não conseguem responder:

* O que o agente fez?
* Por que tomou determinada decisão?
* Qual ferramenta executou?
* Onde ocorreu a falha?
* Quanto custou?
* Como reproduzir o problema?

Os logs existem.

A explicabilidade operacional não.

---

# Target Users

## Primary

AI Engineers

## Secondary

Platform Engineers

---

# Product Pillars

## Trace

Capturar toda execução.

## Replay

Reproduzir comportamentos.

## Cost

Monitorar consumo.

## Tool Analytics

Entender desempenho operacional.

---

# Core Features

## Agent Tracing

Captura:

* prompts
* mensagens
* tool calls
* outputs
* erros
* metadados

---

## Trace Explorer

Visualização completa da árvore de execução.

---

## Session Replay

Reprodução visual:

User

↓

Agent

↓

Tools

↓

Response

---

## Cost Tracking

Métricas:

* input tokens
* output tokens
* requests
* custo estimado

Agrupadas por:

* agente
* modelo
* ferramenta

---

## Tool Analytics

Métricas:

* sucesso
* erro
* latência
* frequência

---

# Architecture

## SDK

TypeScript

## Collector

OTLP + HTTP

## Pipeline

Ingest

↓

Normalize

↓

Store

↓

Metrics

## Storage

PostgreSQL

## UI

React
TypeScript
TanStack
Tailwind

---

# Dashboard

## Overview

* requests
* erros
* custo
* latência

## Traces

Lista de execuções.

## Trace Explorer

Detalhamento completo.

## Replay

Reprodução visual.

## Costs

Custos.

## Tools

Ferramentas.

---

# Out of Scope

* Evaluations
* Benchmarks
* Datasets
* Memory Inspector
* Alerts
* Governance
* Prompt Management
* Agent Simulation

---

# Success Criteria

Um desenvolvedor externo consegue:

1. Instalar o SDK
2. Instrumentar um agente
3. Visualizar traces
4. Executar replay
5. Analisar custos
6. Subir tudo com Docker Compose

---

# North Star Metric

Traces ingeridos por dia.

Métrica secundária:

Replay sessions por semana.

---

# Positioning

OpenTelemetry-native observability platform for AI agents.
