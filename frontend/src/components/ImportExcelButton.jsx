import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSpreadsheet } from 'lucide-react';
import Button from './ui/Button.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { showBulkTools } from '../constants/permissions.js';

// "Import Excel file": pick an .xlsx / .csv file, then the page that takes
// those rows (a sheet, or Stock) opens with them already filled in -- check
// them there and save.
export default function ImportExcelButton({ to, label = 'Import Excel file' }) {
  const input = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  // Super Admin only, once switched on in Settings.
  if (!showBulkTools(user)) return null;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,.txt"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) navigate(to, { state: { importFile: file } });
        }}
      />
      <Button onClick={() => input.current?.click()}>
        <FileSpreadsheet className="h-4 w-4" /> {label}
      </Button>
    </>
  );
}
