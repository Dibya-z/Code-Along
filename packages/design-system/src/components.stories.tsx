import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Field, Notice, Dialog } from './components.tsx';
const meta = {
  title: 'Code Along/Primitives',
  component: Button,
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Actions: Story = {
  render: () => (
    <div
      style={{
        display: 'flex',
        gap: '1rem',
        padding: '2rem',
        flexWrap: 'wrap',
      }}
    >
      <Button>Create project</Button>
      <Button variant="secondary">Cancel</Button>
      <Button busy>Creating…</Button>
      <Button disabled>Unavailable</Button>
    </div>
  ),
};
export const FormStates: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gap: '1.5rem',
        padding: '2rem',
        maxWidth: '28rem',
      }}
    >
      <Field
        label="Workspace name"
        hint="Choose a name your group will recognise."
      />
      <Field
        label="Email address"
        type="email"
        error="Enter a valid email address."
      />
      <Notice tone="error">
        The request could not be completed. Try again.
      </Notice>
      <Notice tone="success">Workspace created.</Notice>
    </div>
  ),
};
export const AccessibleDialog: Story = {
  render: () => (
    <Dialog
      title="Invite a member"
      description="Choose who can join your workspace."
      trigger={<Button>Invite member</Button>}
    >
      <Field label="Email address" type="email" />
    </Dialog>
  ),
};
