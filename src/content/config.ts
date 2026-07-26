import { defineCollection, z } from "astro:content";

const posts = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    author: z.string().default("blues"),
    character: z.union([z.string(), z.array(z.string())]).default("Blues"),
    type: z.enum(["image", "video", "text", "fanart"]).default("image"),
    date: z.date(),
    image: z.string().optional(),
    images: z.array(z.string()).optional(),
    imageCharacters: z.array(z.string()).optional(),
    video: z.string().optional(),
    excerpt: z.string().optional(),
    fanartSourceUrl: z.string().optional(),
    fanartSourceStatus: z.string().optional(),
    fanartArtist: z.string().optional(),
    fanartArtistUrl: z.string().optional(),
    fanartArtistStatus: z.string().optional(),
    draft: z.boolean().default(false)
  })
});

const test = defineCollection({
  type: "content",
  schema: posts.schema
});

const loosePageContent = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string().optional()
  }).passthrough()
});

export const collections = {
  posts,
  test,
  about: loosePageContent,
  characters: loosePageContent,
  world: loosePageContent
};
