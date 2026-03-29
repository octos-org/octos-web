import {
  Sparkles,
  FileText,
  Headphones,
  Presentation,
  Image,
  BookOpen,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { OutputType, GenerationOptions } from "./types";

export interface OptionField {
  key: string;
  label: string;
  type: "select" | "text";
  options?: { value: string; label: string }[];
  default?: string;
}

export interface TileConfig {
  type: OutputType;
  label: string;
  description: string;
  icon: LucideIcon;
  color: string;
  available: boolean;
  defaultOptions: GenerationOptions;
  optionFields: OptionField[];
}

export const GENERATION_TILES: TileConfig[] = [
  {
    type: "summary",
    label: "Summary",
    description: "Concise synthesis of your sources",
    icon: Sparkles,
    color: "text-yellow-400",
    available: true,
    defaultOptions: { length: "medium", language: "English" },
    optionFields: [
      {
        key: "length",
        label: "Length",
        type: "select",
        options: [
          { value: "short", label: "Brief (1-2 paragraphs)" },
          { value: "medium", label: "Standard (1 page)" },
          { value: "long", label: "Detailed (2-3 pages)" },
        ],
        default: "medium",
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        options: [
          { value: "English", label: "English" },
          { value: "Chinese", label: "Chinese" },
          { value: "Japanese", label: "Japanese" },
        ],
        default: "English",
      },
    ],
  },
  {
    type: "report",
    label: "Research Report",
    description: "In-depth research with citations",
    icon: FileText,
    color: "text-link",
    available: true,
    defaultOptions: { depth: 2, language: "English" },
    optionFields: [
      {
        key: "depth",
        label: "Research Depth",
        type: "select",
        options: [
          { value: "1", label: "Quick (1 round)" },
          { value: "2", label: "Standard (3 rounds)" },
          { value: "3", label: "Deep (5 rounds)" },
        ],
        default: "2",
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        options: [
          { value: "English", label: "English" },
          { value: "Chinese", label: "Chinese" },
        ],
        default: "English",
      },
    ],
  },
  {
    type: "podcast",
    label: "Podcast",
    description: "Audio overview of your content",
    icon: Headphones,
    color: "text-accent",
    available: true,
    defaultOptions: { voice: "vivian", length: "medium", language: "English" },
    optionFields: [
      {
        key: "voice",
        label: "Voice",
        type: "select",
        options: [
          { value: "vivian", label: "Vivian (Female)" },
          { value: "serena", label: "Serena (Female)" },
          { value: "ryan", label: "Ryan (Male)" },
          { value: "aiden", label: "Aiden (Male)" },
          { value: "eric", label: "Eric (Male)" },
        ],
        default: "vivian",
      },
      {
        key: "length",
        label: "Length",
        type: "select",
        options: [
          { value: "short", label: "Brief (1-2 min)" },
          { value: "medium", label: "Standard (3-5 min)" },
          { value: "long", label: "Extended (8-10 min)" },
        ],
        default: "medium",
      },
      {
        key: "language",
        label: "Language",
        type: "select",
        options: [
          { value: "english", label: "English" },
          { value: "chinese", label: "Chinese" },
          { value: "japanese", label: "Japanese" },
          { value: "korean", label: "Korean" },
        ],
        default: "english",
      },
    ],
  },
  {
    type: "slides",
    label: "Slide Deck",
    description: "Presentation from your sources",
    icon: Presentation,
    color: "text-green-400",
    available: true,
    defaultOptions: { template: "business", length: "medium" },
    optionFields: [
      {
        key: "template",
        label: "Style",
        type: "select",
        options: [
          { value: "business", label: "Business / Professional" },
          { value: "academic", label: "Academic / Research" },
          { value: "creative", label: "Creative / Storytelling" },
          { value: "minimal", label: "Minimal / Clean" },
        ],
        default: "business",
      },
      {
        key: "length",
        label: "Slides",
        type: "select",
        options: [
          { value: "short", label: "Brief (8-10 slides)" },
          { value: "medium", label: "Standard (15-20 slides)" },
          { value: "long", label: "Detailed (25-30 slides)" },
        ],
        default: "medium",
      },
    ],
  },
  {
    type: "infographic",
    label: "Infographic",
    description: "Visual summary of key points",
    icon: Image,
    color: "text-purple-400",
    available: false,
    defaultOptions: { style: "modern" },
    optionFields: [],
  },
  {
    type: "comic",
    label: "Comic",
    description: "Illustrated story from content",
    icon: BookOpen,
    color: "text-pink-400",
    available: false,
    defaultOptions: { style: "manga" },
    optionFields: [],
  },
  {
    type: "website",
    label: "Website",
    description: "Landing page from your content",
    icon: Globe,
    color: "text-teal-400",
    available: false,
    defaultOptions: { template: "landing" },
    optionFields: [],
  },
];
