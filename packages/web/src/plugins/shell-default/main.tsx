import { createRoot } from 'react-dom/client';
import '../../styles/theme.css';
import { ShellDefaultApp } from './ShellDefaultApp';

createRoot(document.getElementById('root')!).render(<ShellDefaultApp />);
