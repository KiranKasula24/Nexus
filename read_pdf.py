import pypdf
import os

pdf_path = r'C:\Projects\nexus\nexus_MU.pdf'
if os.path.exists(pdf_path):
    with open(pdf_path, 'rb') as f:
        reader = pypdf.PdfReader(f)
        text = ''
        for page in reader.pages:
            text += page.extract_text()
        print(text)
else:
    print('File not found')
