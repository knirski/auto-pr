import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://knirski.github.io',
  base: '/auto-pr',
  integrations: [
    starlight({
      title: 'auto-pr',
      logo: {
        src: './src/assets/logo.svg',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/knirski/auto-pr' },
      ],
      customCss: ['./src/styles/custom.css'],
      editLink: {
        baseUrl: 'https://github.com/knirski/auto-pr/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'User Guide',
          items: [
            { slug: 'integration' },
            { slug: 'troubleshooting' },
            { slug: 'pr-template' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { slug: 'architecture' },
            { slug: 'ci' },
            { slug: 'workflow-security' },
            { slug: 'cii' },
          ],
        },
        {
          label: 'ADRs',
          autogenerate: { directory: 'adr' },
        },
      ],
    }),
  ],
});
