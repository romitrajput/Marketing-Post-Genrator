import { useRoute } from './lib/session';
import Landing from './pages/Landing';
import UploadPage from './pages/Upload';
import AnalysePage from './pages/Analyse';
import StudioPage from './pages/Studio';
import ProjectsPage from './pages/Projects';

export default function App() {
  const route = useRoute();
  switch (route) {
    case 'upload':
      return <UploadPage />;
    case 'analyse':
      return <AnalysePage />;
    case 'studio':
      return <StudioPage />;
    case 'projects':
      return <ProjectsPage />;
    default:
      return <Landing />;
  }
}
